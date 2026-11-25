// T-465: one failing check on two PRs gets one shared chat channel, each blocked Dev is told its name, the first fix
// to merge tells the others and closes the failure's ticket, and the channel is archived once nobody waits on
// it. Through a real relay with a fake `claude` and a fake `gh` (relay/failures.js, relay/failures-plan.js).
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, removeDir, sleep, until, sessionToken } = require('./helpers.js');

const url = (n) => 'https://github.com/acme/widgets/pull/' + n;
const RUN = 'https://github.com/acme/widgets/actions/runs/777/job/1';
const FAILED = { __typename: 'CheckRun', name: 'browser', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: RUN };
const PASSED = { __typename: 'CheckRun', name: 'browser', status: 'COMPLETED', conclusion: 'SUCCESS' };
const tokenOf = (s) => until(() => { try { return { 'X-Office-Token': sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'the token');

test('a failure on two PRs: one channel, both Devs told, the fix tells the other and closes the ticket, then it is archived', async (t) => {
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ RELAY_WIP_LIMIT: '8', RELAY_REVIEW_GRACE_MS: '600000', RELAY_CHAT_POLL_SECONDS: '1', RELAY_PIPELINE_POLL_SECONDS: '1', RELAY_LEAD_CHECK_MS: '3000', GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); removeDir(gh); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t'].concat(args), { cwd, encoding: 'utf8' }).trim();
  git(R.home, 'init', '-q', '--bare', origin);
  git(repo, 'config', 'url.' + origin + '.insteadOf', 'https://github.com/acme/widgets.git');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  git(repo, 'push', '-q', 'origin', 'main');
  await R.call('POST', '/reviews', { auto: false });
  const answers = (prs) => fs.writeFileSync(path.join(gh, 'answers.json'), JSON.stringify({ prs }));
  const rollup = (n, checks, state, extra) => ({ [url(n)]: Object.assign({ state: state || 'OPEN', headRefOid: String(n).repeat(40).slice(0, 40), statusCheckRollup: checks }, extra || {}) });
  const hook = async (s, event) => { await R.hook({ session_id: s.sessionId.slice(0, 12), ...event }); await sleep(150); };
  const taskOf = async (id) => (await R.call('GET', '/tasks/' + id)).body.task;
  const chats = async () => (await R.call('GET', '/chat')).body.rooms;
  const posts = async (name) => (await R.call('GET', '/chat/' + name)).body.posts.map((p) => p.text).join('\n');
  const started = async (title, pr) => {
    const ticket = (await R.call('POST', '/tickets', { title, body: 'Do it.', repo })).body.ticket;
    const task = (await R.call('POST', '/tickets/' + ticket.id + '/start', {})).body.task;
    await hook(task.owner, { hook_event_name: 'PostToolUse', tool_name: 'Bash', pr_url: pr });
    await until(async () => (await taskOf(task.id)).pr === pr, 'the PR link');
    const terminal = (await taskOf(task.id)).worker.terminal;
    await hook(task.owner, { hook_event_name: 'UserPromptSubmit' });
    await hook(task.owner, { hook_event_name: 'Stop' });
    await until(async () => /GOT\[Your task is to build/.test(await R.screen(terminal, 300)), 'the brief typed');
    await hook(task.owner, { hook_event_name: 'UserPromptSubmit' });
    await hook(task.owner, { hook_event_name: 'Stop' });
    await until(async () => (await taskOf(task.id)).briefed, 'the brief');
    return { ticket, task, terminal };
  };
  const one = await started('First change', url(1)), two = await started('Second change', url(2));
  const failureTicket = (await R.call('POST', '/tickets', { title: 'The browser check is flaky', body: 'It fails now and then.', repo })).body.ticket;
  const screen = (x) => R.screen(x.terminal, 500);

  await t.test('one PR with the failure opens no channel', async () => {
    answers({ ...rollup(1, [FAILED]), ...rollup(2, [PASSED]) });
    await sleep(3000);
    assert.deepStrictEqual((await chats()).filter((r) => r.kind === 'failure'), []);
  });

  await t.test('the same failure on two PRs opens one channel and tells both Devs its name', async () => {
    answers({ ...rollup(1, [FAILED]), ...rollup(2, [FAILED]) });
    await until(async () => (await chats()).some((r) => r.name === 'failure-browser'), 'the channel');
    assert.strictEqual((await chats()).filter((r) => r.kind === 'failure').length, 1);
    await sleep(2500);
    assert.strictEqual((await chats()).filter((r) => r.kind === 'failure').length, 1, 'not again on the next look');
    assert.match(await posts('failure-browser'), /The check "browser" failed on 2 open PRs: PR #1, PR #2\./);
    for (const x of [one, two]) await until(async () => /failure-browser/.test(await screen(x)), 'the Dev to be told', 100);
    const told = await screen(one);
    assert.match(told, /fix it in your PR as its own commit/);
    assert.match(told, /Do not wait for another Dev, and do not file a ticket for it/);
  });

  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: lead.sessionId.slice(0, 12), title: '' });
  await until(async () => (await R.call('POST', '/terminals/lead', { terminal: lead.id })).status === 200, 'the Lead');
  await R.hook({ hook_event_name: 'Stop', session_id: lead.sessionId.slice(0, 12) });
  const leadT = await tokenOf(lead);

  await t.test('the Lead may rerun a known-flaky job, once for a commit, and only while the person lets it', async () => {
    assert.strictEqual((await R.call('POST', '/rerun', { pr: url(1) }, leadT)).status, 403, 'off by default');
    assert.strictEqual((await R.call('POST', '/settings', { values: { leadUnstick: true } })).status, 200);
    const first = await R.call('POST', '/rerun', { pr: url(1) }, leadT);
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const second = await R.call('POST', '/rerun', { pr: url(1) }, leadT);
    assert.strictEqual(second.status, 409);
    assert.strictEqual(second.body.error, 'already_rerun');
    assert.strictEqual(fs.readFileSync(path.join(gh, 'rerun.log'), 'utf8'), '777 --failed -R acme/widgets\n', 'gh ran the rerun once');
  });

  await t.test('while a blocked Dev runs, the Lead sets no priority for the failure\'s ticket and starts no separate fix', async () => {
    assert.strictEqual((await R.call('POST', '/failures/failure-browser/tickets', { ticket: failureTicket.id })).status, 200);
    const refused = await R.call('POST', '/tickets/' + failureTicket.id + '/edit', { priority: 'high' }, leadT);
    assert.strictEqual(refused.status, 403);
    assert.match(refused.body.message, /A Dev blocked by this failure is running \(PR #1, PR #2\)/);
  });

  await t.test('when a Dev posts a fix, the Lead\'s next pass names who posted and the other blocked Dev to tell', async () => {
    const said = await R.call('POST', '/chat/failure-browser', { text: 'Pushed a fix, and it passes' }, await tokenOf(one.task.owner));
    assert.strictEqual(said.status, 201, JSON.stringify(said.body));
    const pass = async () => { const m = (await R.screen(lead.id, 400)).match(/Failure channels open now: #failure-browser \(browser\): blocks (.*?) New posts from (.+?)\. Read them with ticket\.js chat failure-browser\. If one has a fix that passes, tell (.+?) by name to take it or stop theirs, and ask for the review of that PR first\./); return m && { blocks: m[1], poster: m[2], told: m[3] }; };
    const got = await until(pass, 'the Lead\'s pass', 150);
    assert.notStrictEqual(got.poster, got.told, 'it tells the other Dev, not the one who posted');
    assert.ok(got.blocks.includes(got.poster) && got.blocks.includes(got.told), got.blocks);
    assert.ok(!(await R.screen(lead.id, 400)).includes('Pushed a fix'), 'the post\'s words are not typed in');
  });

  await t.test('a ticket linked to the failure closes when the first fix merges, and the other Dev is told to take main', async () => {
        answers({ ...rollup(1, [FAILED]), ...rollup(2, [PASSED], 'MERGED', { mergedAt: '2026-11-25T10:00:00Z' }) });
    await until(async () => /Main now has the fix for the check "browser" \(PR #2\)/.test(await screen(one)), 'the other Dev to be told', 100);
    assert.match(await screen(one), /drop yours and keep main's/);
    assert.doesNotMatch(await screen(two), /Main now has the fix/, 'the Dev whose PR merged is not told');
    assert.match(await posts('failure-browser'), /The fix merged: PR #2\. Main has it\./);
    await until(async () => (await R.call('GET', '/tickets/' + failureTicket.id)).body.ticket.status === 'rejected', 'the ticket to close');
    const closed = (await R.call('GET', '/tickets/' + failureTicket.id)).body.ticket;
    assert.ok(closed.notes.some((n) => n.by === 'the relay' && /fixed by PR #2, which merged/.test(n.text) && /also blocked #1/.test(n.text)), JSON.stringify(closed.notes));
    const jams = (await R.call('GET', '/jams')).body.jams.filter((j) => j.by === 'room');
    assert.deepStrictEqual(jams.map((j) => [j.kind, j.blocked, j.pr]), [['other', 2, url(2)]], 'one jam for the channel');
    assert.strictEqual((await R.call('GET', '/metrics')).body.lead.failures.channels, 1);
  });

  await t.test('the channel stays while PR 1 still fails, and is archived once it passes the check', async () => {
    await sleep(2500);
    assert.strictEqual((await chats()).find((r) => r.name === 'failure-browser').archived, null);
    answers({ ...rollup(1, [PASSED]), ...rollup(2, [PASSED], 'MERGED', { mergedAt: '2026-11-25T10:00:00Z' }) });
    await until(async () => (await chats()).find((r) => r.name === 'failure-browser').archived, 'the channel to be archived');
    assert.match((await chats()).find((r) => r.name === 'failure-browser').archived.why, /the fix merged and every PR it blocked has merged, closed or passed the check/);
    assert.match(await posts('failure-browser'), /Summary: the check "browser" blocked 2 PRs/);
    const post = await R.call('POST', '/chat/failure-browser', { text: 'late' });
    assert.strictEqual(post.status, 409);
  });

  await t.test('the same check failing again opens a new channel and keeps the archived one with its history', async () => {
    const again = await R.call('POST', '/failures', { check: 'browser', prs: [url(1), url(2)] });
    assert.strictEqual(again.status, 201, JSON.stringify(again.body));
    const rooms = (await chats()).filter((r) => r.kind === 'failure');
    const old = rooms.find((r) => r.name === 'failure-browser-2');
    assert.ok(old && old.archived, JSON.stringify(rooms.map((r) => [r.name, r.archived])));
    assert.match(await posts('failure-browser-2'), /Summary: the check "browser" blocked 2 PRs/);
  });

  await t.test('PRs that fail the aggregate pipeline check and different jobs share no channel on pipeline', async () => {
    const AGGREGATE = { __typename: 'CheckRun', name: 'pipeline', status: 'COMPLETED', conclusion: 'FAILURE' };
    answers({ ...rollup(1, [AGGREGATE, { ...FAILED, name: 'lint and npm test' }]), ...rollup(2, [AGGREGATE, { ...FAILED, name: 'the room in a container' }]) });
    await sleep(3000);
    assert.ok(!(await chats()).some((r) => r.name === 'failure-pipeline'), 'no channel named for the aggregate');
  });

  await t.test('a channel whose blocked PR passes with no merge is archived with its own reason in the jam', async () => {
    const opened = await R.call('POST', '/failures', { check: 'lint', prs: [url(1), url(3)] });
    assert.strictEqual(opened.status, 201, JSON.stringify(opened.body));
    answers({ ...rollup(1, [PASSED]), ...rollup(2, [PASSED], 'MERGED', { mergedAt: '2026-11-25T10:00:00Z' }) });
    await until(async () => (await chats()).find((r) => r.name === 'failure-lint').archived, 'the channel to be archived');
    const jam = (await R.call('GET', '/jams')).body.jams.filter((j) => j.by === 'room').pop();
    assert.match(jam.fix, /Every PR it blocked passed the check and no fix merged/);
    assert.doesNotMatch(jam.fix, /24 hours/);
  });
});
