// The Lead marks a PR ready to merge (T-107): one note headed Ready to merge and a "ready to merge" label,
// and a new commit takes the label off. Through a real relay with a fake `claude` and a fake `gh`.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, removeDir, sleep, until, sessionToken, ROOT } = require('./helpers.js');

const CLI = path.join(ROOT, 'relay', 'ticket.js');
const PR = 'https://github.com/acme/widgets/pull/12';
const FILES = 'repos/acme/widgets/pulls/12/files';
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', NEXT = 'ffffeeee0000111122223333444455556666aaaa';
const THIRD = '3333333333333333333333333333333333333333', FOURTH = '4444444444444444444444444444444444444444';
const GREEN = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const NOTE = 'Reviews: https://github.com/acme/widgets/pull/12#issuecomment-1, verdict merge.\nFindings: the one blocking finding is fixed in a1b2c3d, checked in relay/x.js.\nHand checks still open: none.\n';

test('who merges, the parts of the note, and what the relay refuses', () => {
  const { whoMerges, missingParts, noteOf, refusal } = require('../ready-plan.js');
  assert.strictEqual(whoMerges(['relay/x.js']), 'the person.');
  assert.match(whoMerges(['relay/x.js'], { leadMerges: true }), /^the Lead, under the merge rung/);
  assert.match(whoMerges(['relay/x.js'], { leadMerges: true, autopilot: true }), /^Autopilot/);
  for (const f of ['CLAUDE.md', 'docs/constitution.md', 'eslint.config.js', 'eslint-local.js']) {
    assert.match(whoMerges(['relay/x.js', f], { leadMerges: true, autopilot: true }), new RegExp('^the person, since it changes ' + f.replace(/\./g, '\\.')), f + ' is the person\'s, whatever the switches say');
  }
  assert.strictEqual(missingParts(NOTE), null);
  assert.deepStrictEqual(missingParts('Reviews: one\nFindings: fixed'), ['Hand checks still open:']);
  const p = { state: 'OPEN', baseRefName: 'main', headRefOid: HEAD, statusCheckRollup: GREEN, mergeable: 'MERGEABLE' };
  assert.strictEqual(refusal(p, HEAD.slice(0, 7), null), null);
  assert.match(refusal(Object.assign({}, p, { mergeable: 'UNKNOWN' }), HEAD, null), /try again in a minute/);
  assert.match(refusal(Object.assign({}, p, { statusCheckRollup: [] }), HEAD, null), /not reporting any checks/);
  assert.match(refusal(p, HEAD, 'it has 2 commits the PR does not have'), /Its Dev has a merge hold: it has 2 commits/);
  const note = noteOf({ head: HEAD, who: 'the person.', text: NOTE });
  assert.ok(note.startsWith('<!-- office:ready -->\n## Ready to merge\n'), 'headed Ready to merge');
  assert.ok(note.includes(HEAD) && note.includes('**Who merges:** the person.') && note.includes('Hand checks still open: none.'));
  // pr-comments.js claims state files when it loads, so it loads in a child with a state folder of its own.
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'office-ready-'));
  const ask = (body) => spawnSync('node', ['-e', 'process.stdout.write(String(require(' + JSON.stringify(path.join(ROOT, 'relay', 'pr-comments.js')) + ').isNews({ own: [] }, { body: process.argv[1], kind: "c", url: "u" })))', body], { env: { ...process.env, HOME: state, RELAY_STATE_DIR: state, RELAY_REVIEW_POLL_SECONDS: '0' }, encoding: 'utf8' });
  try {
    assert.strictEqual(ask(note).stdout, 'false', 'every session posts as one login, so without the mark the Dev would get the note as a review');
    assert.strictEqual(ask('## Review of a1b2c3d').stdout, 'true', 'a review is still news');
  } finally { removeDir(state); }
});

test('ticket.js ready', async (t) => {
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ RELAY_PIPELINE_POLL_SECONDS: '1', GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); removeDir(gh); });
  const repo = makeRepo(R.home);
  const answers = (a) => fs.writeFileSync(path.join(gh, 'answers.json'), JSON.stringify(a));
  const pr = (extra) => Object.assign({ state: 'OPEN', baseRefName: 'main', headRefOid: HEAD, statusCheckRollup: GREEN, mergeable: 'MERGEABLE', labels: [] }, extra);
  const files = (...names) => ({ [FILES]: names.map((n) => (typeof n === 'string' ? { filename: n } : n)) });
  const read = (f) => { try { return fs.readFileSync(path.join(gh, f), 'utf8'); } catch (e) { return ''; } };
  const finish = async (s) => { for (const e of ['UserPromptSubmit', 'Stop']) { await R.hook({ session_id: s.sessionId.slice(0, 12), hook_event_name: e, title: '' }); await sleep(150); } };
  const tokenOf = (s) => until(() => { try { return sessionToken(s.sessionId); } catch (e) { return null; } }, 'the token');
  const run = (token, args, input) => spawnSync('node', [CLI, 'ready', ...args], { env: { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: token }, input: input || '', encoding: 'utf8' });

  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body, other = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await finish(lead); await finish(other);
  await R.call('POST', '/terminals/lead', { terminal: lead.id });
  const token = await tokenOf(lead), otherToken = await tokenOf(other);
  const ready = (args, input) => run(token, args, input);

  await t.test('run bare, it says what to check and what the note says', () => {
    const r = ready([]);
    assert.strictEqual(r.status, 1);
    for (const words of ['a review of its current head is posted', 'every blocking finding is fixed', 'Reviews:', 'Findings:', 'Hand checks still open:', 'A new commit takes the label off']) assert.ok(r.stderr.includes(words), words);
    assert.strictEqual(read('posted.log'), '');
  });

  await t.test('only the Lead may mark a PR', () => {
    answers({ prs: { [PR]: pr() }, api: files('relay/x.js') });
    const r = run(otherToken, [PR, HEAD, '--body', '-'], NOTE);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /This session can only/);
    assert.strictEqual(read('posted.log'), '');
  });

  await t.test('a note that leaves out a part is refused', () => {
    const r = ready([PR, HEAD, '--body', '-'], 'Reviews: one\nFindings: fixed\n');
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /needs a line starting with each of: Hand checks still open:/);
    assert.strictEqual(read('posted.log'), '');
  });

  for (const [why, extra, words] of [
    ['a new head', { headRefOid: NEXT }, /Its head is now ffffeee, not a1b2c3d\. Check the new commits first\./],
    ['a red pipeline', { statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }, /pipeline is red/],
    ['a running pipeline', { statusCheckRollup: [{ status: 'IN_PROGRESS' }] }, /pipeline is pending/],
    ['a conflict with main', { mergeable: 'CONFLICTING' }, /conflicts with main/],
    ['another base', { baseRefName: 'develop' }, /Its base is develop, not main/],
    ['a merged PR', { state: 'MERGED' }, /It is merged, not open/],
  ]) {
    await t.test('the relay refuses ' + why + ', and posts nothing', () => {
      answers({ prs: { [PR]: pr(extra) }, api: files('relay/x.js') });
      const r = ready([PR, HEAD.slice(0, 7), '--body', '-'], NOTE);
      assert.strictEqual(r.status, 1, r.stdout);
      assert.match(r.stderr, words);
      assert.strictEqual(read('posted.log'), '');
      assert.strictEqual(read('edited.log'), '');
    });
  }

  await t.test('a ready PR gets one note headed Ready to merge, and the label, made first if the repo has none', () => {
    answers({ prs: { [PR]: pr() }, api: files('relay/x.js'), labels: [] });
    const r = ready([PR, HEAD.slice(0, 7), '--body', '-'], NOTE);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Marked https:\/\/github\.com\/acme\/widgets\/pull\/12 ready to merge at a1b2c3d: .*#issuecomment-\d+\. Who merges: the person\./);
    const posted = read('posted.log').split('\n---\n').filter(Boolean);
    assert.strictEqual(posted.length, 1, 'one comment');
    assert.ok(posted[0].startsWith(PR + '\n<!-- office:ready -->\n## Ready to merge\n'), posted[0]);
    for (const words of ['**Head:** `' + HEAD + '`', '**Who merges:** the person.', NOTE.trim()]) assert.ok(posted[0].includes(words), words);
    assert.match(read('calls.log'), /^label create ready to merge --repo acme\/widgets /m);
    assert.strictEqual(read('edited.log'), PR + ' --add-label ready to merge\n');
  });

  await t.test('marking the same head again posts no second note', () => {
    answers({ prs: { [PR]: pr({ labels: [{ name: 'ready to merge' }] }) }, api: files('relay/x.js'), labels: ['ready to merge'] });
    const r = ready([PR, HEAD, '--body', '-'], NOTE);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Already marked .* at a1b2c3d: .*#issuecomment-\d+\. No new note/);
    assert.strictEqual(read('edited.log').split('--add-label').length - 1, 1, 'the label is on, so nothing is edited');
    assert.strictEqual(read('posted.log').split('\n---\n').filter(Boolean).length, 1, 'still one note');
  });

  await t.test('the label stays while the head stays', async () => {
    answers({ prs: { [PR]: pr({ labels: [{ name: 'ready to merge' }] }) }, labels: ['ready to merge'] });
    await sleep(2500);
    assert.doesNotMatch(read('edited.log'), /--remove-label/);
  });

  await t.test('a new commit takes the label off, once, and #office says so; the note stays', async () => {
    answers({ prs: { [PR]: pr({ headRefOid: NEXT, labels: [{ name: 'ready to merge' }] }) }, labels: ['ready to merge'] });
    await until(() => read('edited.log').includes(PR + ' --remove-label ready to merge'), 'the label to come off');
    await sleep(2500);
    assert.strictEqual(read('edited.log').split('--remove-label').length - 1, 1, 'once');
    assert.strictEqual(read('posted.log').split('\n---\n').filter(Boolean).length, 1, 'the note stays, and nothing new is posted');
    const room = (await R.call('GET', '/chat/office')).body;
    assert.ok(room.posts.some((p) => p.text.includes('PR #12 has a new commit, ffffeee, after the Lead marked a1b2c3d ready to merge')), JSON.stringify(room.posts.map((p) => p.text)));
  });

  await t.test('with merging on, the note says the Lead merges, except a PR that changes or renames a file only a person merges', async () => {
    await finish(lead);
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id, merge: true })).body.merge, true);
    answers({ prs: { [PR]: pr({ headRefOid: NEXT }) }, api: files('relay/x.js'), labels: ['ready to merge'] });
    let r = ready([PR, NEXT, '--body', '-'], NOTE);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /Who merges: the Lead, under the merge rung/);
    answers({ prs: { [PR]: pr({ headRefOid: THIRD }) }, api: files('relay/x.js', 'docs/constitution.md'), labels: ['ready to merge'] });
    r = ready([PR, THIRD, '--body', '-'], NOTE);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /Who merges: the person, since it changes docs\/constitution\.md/);
    answers({ prs: { [PR]: pr({ headRefOid: FOURTH }) }, api: files({ filename: 'docs/rules.md', previous_filename: 'CLAUDE.md' }), labels: ['ready to merge'] });
    r = ready([PR, FOURTH, '--body', '-'], NOTE);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /Who merges: the person, since it changes CLAUDE\.md/, 'a rename counts');
    assert.match(read('calls.log'), /^api --paginate --slurp repos\/acme\/widgets\/pulls\/12\/files\?per_page=100$/m, 'every page of files, not the first 100');
  });

  await t.test('a PR that merged is no longer watched, and keeps its label', async () => {
    answers({ prs: { [PR]: pr({ state: 'MERGED', headRefOid: FOURTH, labels: [{ name: 'ready to merge' }] }) }, labels: ['ready to merge'] });
    const before = read('edited.log');
    await until(() => !Object.keys(JSON.parse(fs.readFileSync(path.join(R.home, '.office-world', 'ready.json'), 'utf8'))).length, 'the PR to be dropped');
    assert.strictEqual(read('edited.log'), before);
  });
});

test('with the pipeline check at 0, a new commit still takes the label off, and a failed label is retried without a second note', async (t) => {
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ RELAY_PIPELINE_POLL_SECONDS: '0', RELAY_READY_POLL_SECONDS: '1', GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); removeDir(gh); });
  const answers = (a) => fs.writeFileSync(path.join(gh, 'answers.json'), JSON.stringify(a));
  const read = (f) => { try { return fs.readFileSync(path.join(gh, f), 'utf8'); } catch (e) { return ''; } };
  const pr = (extra) => Object.assign({ state: 'OPEN', baseRefName: 'main', headRefOid: HEAD, statusCheckRollup: GREEN, mergeable: 'MERGEABLE', labels: [] }, extra);
  const api = { [FILES]: [{ filename: 'relay/x.js' }] };
  answers({ prs: { [PR]: pr() }, api, labels: [], failLabel: 'HTTP 403: Resource not accessible' });
  let r = await R.call('POST', '/ready', { pr: PR, head: HEAD, text: NOTE });
  assert.strictEqual(r.status, 502);
  assert.match(r.body.message, /The note is posted .*, but gh could not add the label: HTTP 403/);
  await sleep(2500);
  answers({ prs: { [PR]: pr() }, api, labels: [] });
  r = await R.call('POST', '/ready', { pr: PR, head: HEAD, text: NOTE });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.again, true, 'the watch kept the mark whose label failed');
  assert.strictEqual(read('posted.log').split('\n---\n').filter(Boolean).length, 1, 'the retry posts no second note');
  assert.match(read('edited.log'), /--add-label ready to merge\n$/);
  answers({ prs: { [PR]: pr({ headRefOid: NEXT, labels: [{ name: 'ready to merge' }] }) }, labels: ['ready to merge'] });
  await until(() => read('edited.log').includes(PR + ' --remove-label ready to merge'), 'the label to come off with the pipeline check off');
});

test('the Lead\'s brief says to mark ready PRs with ticket.js ready', () => {
  const { leadBrief } = require('../lead-brief.js');
  for (const opts of [{}, { merge: true }, { autopilot: true }, { merge: true, autopilot: true }]) assert.ok(leadBrief('/r/relay', opts).includes('Mark ready PRs with ticket.js ready'), JSON.stringify(opts));
});
