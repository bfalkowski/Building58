'use strict';
// A follow-up reviewer is given every earlier round of the PR (T-297), not only the last: each round's
// verdict, its findings and how the Dev answered. The first review is unchanged.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until } = require('./helpers.js');
const history = require('../review-history.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const PR = 'https://github.com/acme/widgets/pull/51';
const note = (id, minute, body) => ({ id, body, created_at: '2026-11-20T10:0' + minute + ':00Z', html_url: PR + '#issuecomment-' + id });

test('the third review of a PR is given rounds 1 and 2, and the first is not', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir }, null, { autoReview: true }), repo = makeRepo(R.home);
  t.after(R.stop);
  const answers = (items) => fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ api: { 'repos/acme/widgets/issues/51/comments': items } }));
  answers([]);
  const origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  let n = 0;
  const commit = () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'change ' + (++n) + '\n');
    sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'change ' + n);
    sh(repo, 'push', '-qf', origin, 'HEAD:refs/pull/51/head');
    return sh(repo, 'rev-parse', 'HEAD');
  };
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const seen = new Set();
  const newReviewer = () => until(async () => (await terminals()).find((x) => x.role === 'reviewer' && x.pr === PR && !seen.has(x.id) && seen.add(x.id)), 'a review');
  const stop = async (s) => { await R.call('POST', '/terminals/' + s.id + '/stop', {}); await until(async () => !(await terminals()).some((x) => x.id === s.id), 'it to stop'); };
  const push = async (d) => { await say(d, 'UserPromptSubmit'); const h = commit(); await say(d, 'PostToolUse', { pushed: true }); await say(d, 'Stop'); return h; };

  assert.strictEqual((await R.call('POST', '/reviews', { again: true })).body.again, true);
  const d = (await R.call('POST', '/terminals', { cwd: repo })).body;
  const h1 = commit();
  await say(d, 'PostToolUse', { pr_url: PR, cwd: repo });
  const first = await newReviewer();
  const screenOf = async (s) => (await until(async () => { const x = await R.screen(s.id); return x.includes('GOT[') && x; }, 'its prompt'));
  assert.ok(!(await screenOf(first)).includes('Earlier reviews'), 'the first review has no history');
  await stop(first);

  const one = '# Review of ' + h1.slice(0, 12) + '\nVerdict: fix\n- blocking: ALPHA-FINDING the lock is never released\n';
  const reply1 = '<!-- office:dev -->\nFixed ALPHA-ANSWER in the next commit.';
  answers([note(1, 1, one), note(2, 2, reply1)]);
  const h2 = await push(d);
  const second = await newReviewer();
  const s2 = await screenOf(second);
  assert.ok(s2.includes('ALPHA-FINDING') && s2.includes('ALPHA-ANSWER'), 'round 1 is in round 2\'s prompt');
  await stop(second);

  const two = '# Review of ' + h2.slice(0, 12) + '\nVerdict: merge\n- follow-up: BETA-FINDING rename the flag\n';
  answers([note(1, 1, one), note(2, 2, reply1), note(3, 3, two)]);
  await push(d);
  const third = await newReviewer();
  const s3 = await screenOf(third);
  for (const word of ['ALPHA-FINDING', 'ALPHA-ANSWER', 'BETA-FINDING', 'Round 1', 'Round 2', 'verdict fix', 'verdict merge']) assert.ok(s3.includes(word), word + ' is in the third review\'s prompt: ' + s3);
  await stop(third);
  await stop(d);
});

test('long rounds are cut to their findings, and the prompt says so', () => {
  const long = (k) => ({ id: k, kind: 'c', at: k, body: '# Review of abcdef' + k + '0\nVerdict: fix\n' + 'Long prose about nothing in particular. '.repeat(300) + '\n- blocking: FINDING-' + k + ' is broken\n' });
  const out = history.text([long(1), long(2), long(3)], { budget: 3000 });
  assert.ok(out.length <= 3000, 'fits: ' + out.length);
  assert.ok(out.includes('cut to their findings'));
  for (const k of [1, 2, 3]) assert.ok(out.includes('FINDING-' + k), 'finding ' + k);
  assert.ok(!out.includes('Long prose'));
});

test('a closed earlier PR is named, with why when known', () => {
  const out = history.text([{ id: 1, kind: 'c', at: 1, body: '# Review of abcdef1\nVerdict: merge\n- ok\n' }], { earlier: { pr: 'https://github.com/acme/widgets/pull/9', why: 'wrong approach' } });
  assert.ok(out.includes('pull/9') && out.includes('closed without a merge: wrong approach'));
});
