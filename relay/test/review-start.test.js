'use strict';
// A Dev is told when a review of its PR starts (T-141): the PR, the commit the reviewer reads, and the
// reviewer's name. A follow-up review counts as a start too. No room page is connected, so the relay
// alone tells it, with the name the relay gave the reviewer (relay/seats.js).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until } = require('./helpers.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const PR = (n) => 'https://github.com/acme/widgets/pull/' + n;

test('the Dev is told which PR, which commit and which reviewer, at the first review and at a follow-up', async (t) => {
  const R = await relay({}, null, { autoReview: true }), repo = makeRepo(R.home);
  t.after(R.stop);
  const origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  let n = 0;
  const commit = (pr) => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'change ' + (++n) + '\n');
    sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'change ' + n);
    sh(repo, 'push', '-qf', origin, 'HEAD:refs/pull/' + pr.split('/').pop() + '/head');
    return sh(repo, 'rev-parse', 'HEAD');
  };
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const seen = new Set();
  const newReviewer = (pr) => until(async () => (await terminals()).find((x) => x.role === 'reviewer' && x.pr === pr && !seen.has(x.id) && seen.add(x.id)), 'a review of ' + pr);
  const stop = async (s) => { await R.call('POST', '/terminals/' + s.id + '/stop', {}); await until(async () => !(await terminals()).some((x) => x.id === s.id), 'it to stop'); };
  const told = (d, text) => until(async () => (await R.screen(d.id)).includes('GOT[' + text), 'the Dev to be told: ' + text);

  assert.strictEqual((await R.call('POST', '/reviews', { again: true })).body.again, true);
  const r = await R.call('POST', '/terminals', { cwd: repo });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const d = r.body, pr = PR(41);
  const h1 = commit(pr);
  await say(d, 'PostToolUse', { pr_url: pr, cwd: repo });
  const first = await newReviewer(pr);
  assert.ok(first.who && first.who !== d.who, 'the reviewer has a name of its own: ' + first.who);
  await told(d, 'A review of your PR ' + pr + ' started. ' + first.who + ' is reviewing commit ' + h1 + '.');
  await stop(first);

  // A push brings a follow-up review, of the new commit.
  await say(d, 'UserPromptSubmit');
  const h2 = commit(pr);
  await say(d, 'PostToolUse', { pushed: true }); await say(d, 'Stop');
  const second = await newReviewer(pr);
  await told(d, 'A review of your PR ' + pr + ' started. ' + second.who + ' is reviewing commit ' + h2 + '.');
  await stop(second);
  await stop(d);
});
