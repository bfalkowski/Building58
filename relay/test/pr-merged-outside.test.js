// T-289: a task's PR merged or closed on GitHub, not by the relay. Through a real relay with a fake `claude` and
// a fake `gh`, with Watch each open PR off: the card says so, Needs you lists it once with a Done button, the
// person's Done moves the task and its ticket, the Lead may move the task to Done under Autopilot, and a PR closed
// with no merge gets its own line and no Done.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, removeDir, sleep, until, sessionToken } = require('./helpers.js');

const url = (n) => 'https://github.com/acme/widgets/pull/' + n;

test('a PR merged or closed on GitHub shows in Needs you and on the card', async (t) => {
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ RELAY_WIP_LIMIT: '8', RELAY_REVIEW_GRACE_MS: '600000', RELAY_CHAT_POLL_SECONDS: '1', GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); removeDir(gh); });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t'].concat(args), { cwd, encoding: 'utf8' }).trim();
  git(R.home, 'init', '-q', '--bare', origin);
  git(repo, 'config', 'url.' + origin + '.insteadOf', 'https://github.com/acme/widgets.git');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  git(repo, 'push', '-q', 'origin', 'main');
  await R.call('POST', '/reviews', { auto: false });
  const answers = (a) => fs.writeFileSync(path.join(gh, 'answers.json'), JSON.stringify(a));
  const hook = async (s, event) => { await R.hook({ session_id: s.sessionId.slice(0, 12), ...event }); await sleep(150); };
  const taskOf = async (id) => (await R.call('GET', '/tasks/' + id)).body.task;
  const needs = async () => (await R.call('GET', '/needs-you')).body.items;
  const lines = async (kind) => (await needs()).filter((i) => i.kind === kind);

  const started = async (title, pr) => {
    const ticket = (await R.call('POST', '/tickets', { title, body: 'Do it.', repo })).body.ticket;
    const task = (await R.call('POST', '/tickets/' + ticket.id + '/start', {})).body.task;
    await hook({ sessionId: task.owner.sessionId }, { hook_event_name: 'PostToolUse', tool_name: 'Bash', pr_url: pr });
    await until(async () => (await taskOf(task.id)).pr === pr, 'the PR link');
    return { ticket, task };
  };
  const building = await started('One', url(1)), review = await started('Two', url(2)), waiting = await started('Three', url(3)), closed = await started('Four', url(4));
  await R.call('POST', '/tasks/' + review.task.id + '/move', { to: 'in_review' });
  await R.call('POST', '/tasks/' + waiting.task.id + '/move', { to: 'waiting_on_you' });

  await t.test('open PRs show no merged line', async () => {
    answers({ prs: Object.fromEntries([1, 2, 3, 4].map((n) => [url(n), { state: 'OPEN', statusCheckRollup: [] }])) });
    await sleep(2500);
    assert.deepStrictEqual(await lines('merged'), []);
    assert.strictEqual((await taskOf(building.task.id)).prMerged, false);
  });

  await t.test('a PR merged on GitHub marks the task whatever column it is in, and Needs you lists it once', async () => {
    const prs = Object.fromEntries([1, 2, 3].map((n) => [url(n), { state: 'MERGED', mergedAt: '2026-11-03T10:05:00Z', statusCheckRollup: [] }]));
    prs[url(4)] = { state: 'CLOSED', statusCheckRollup: [] };
    answers({ prs });
    await until(async () => (await lines('merged')).length === 3, 'the merged lines');
    const merged = await lines('merged');
    assert.deepStrictEqual(merged.map((i) => i.task).sort(), [building, review, waiting].map((x) => x.task.id).sort());
    for (const i of merged) {
      assert.deepStrictEqual(Object.keys(i.link).sort(), ['done', 'url']);
      assert.strictEqual(i.link.done, i.task);
      assert.match(i.line, /merged on GitHub\. Move its task to Done\.$/);
      assert.strictEqual((await needs()).filter((x) => x.task === i.task).length, 1, 'once');
    }
    for (const x of [building, review, waiting]) assert.strictEqual((await taskOf(x.task.id)).prMerged, true);
    assert.notStrictEqual((await taskOf(building.task.id)).state, 'done', 'the relay does not move it');
  });

  await t.test('a PR closed with no merge gets its own line and no Done button', async () => {
    const [line] = await lines('closed');
    assert.strictEqual(line.task, closed.task.id);
    assert.deepStrictEqual(line.link, { url: url(4) });
    assert.match(line.line, /closed on GitHub without a merge\. Look at it\. This line stays until the PR is reopened, its task gets a new PR, or its task is Done\.$/);
    await R.call('POST', '/tasks/' + closed.task.id + '/move', { to: 'building' });
    assert.strictEqual((await lines('closed')).length, 1, 'moving the card does not clear it');
    assert.strictEqual((await taskOf(closed.task.id)).prMerged, false);
  });

  await t.test('the person\'s Done moves the task and its ticket', async () => {
    const r = await R.call('POST', '/tasks/' + building.task.id + '/move', { to: 'done' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await taskOf(building.task.id)).state, 'done');
    await until(async () => (await R.call('GET', '/tickets/' + building.ticket.id)).body.ticket.status === 'done', 'the ticket to be done');
    assert.strictEqual((await lines('merged')).length, 2);
  });

  await t.test('under Autopilot the Lead may move that task to Done, and not one whose PR did not merge', async () => {
    const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
    await hook(lead, { hook_event_name: 'UserPromptSubmit', title: '' });
    await hook(lead, { hook_event_name: 'Stop' });
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id, board: true })).body.board, true);
    const token = await until(() => { try { return sessionToken(lead.sessionId); } catch (e) { return null; } }, 'the token');
    const headers = { 'X-Office-Token': token };
    assert.strictEqual((await R.call('POST', '/autopilot', { on: true, only: 'T-999999' })).body.on, true);
    const no = await R.call('POST', '/tasks/' + closed.task.id + '/move', { to: 'done' }, headers);
    assert.deepStrictEqual([no.status, no.body.error], [403, 'autopilot']);
    const ok = await R.call('POST', '/tasks/' + review.task.id + '/move', { to: 'done' }, headers);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual((await taskOf(review.task.id)).state, 'done');
  });
});
