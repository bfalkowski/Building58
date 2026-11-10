'use strict';
// A reviewer's first prompt goes in while an update waits for a quiet moment (T-147). On 2026-11-07
// follow-up reviewers of PR 96 and PR 108 sat for hours with talked: false and their prompt still
// owed: Autopilot pulls main after each merge, so an update was nearly always waiting, the room was
// never quiet, and the relay typed no first prompt until the restart. Now only the restart itself
// holds a first prompt. The update then waits for the review's turn, and the prompt is not typed again
// after the restart. Through a real relay, with a fake claude.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep } = require('./helpers.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, file, text, message) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  sh(cwd, 'add', file);
  sh(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message);
};
const PR = 'https://github.com/acme/widgets/pull/9';
const BRIEF = 'Review PR 9 for T-147';

test('a reviewer started while an update waits gets its first prompt then, and once', async (t) => {
  const R0 = await relay({});
  const home = R0.home;
  await R0.kill();
  // The relay's folder, which Update pulls into from its own origin.
  const src = makeRepo(home, 'src'), relayOrigin = path.join(home, 'relay-origin.git'), dir = path.join(home, 'relay-folder');
  commit(src, 'relay/x.js', '1\n', 'relay file');
  sh(home, 'clone', '-q', '--bare', src, relayOrigin); sh(home, 'clone', '-q', relayOrigin, dir); sh(src, 'remote', 'add', 'origin', relayOrigin);
  // The repo under review, with its PR 9.
  const repo = makeRepo(home), origin = path.join(home, 'origin.git');
  sh(home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  commit(repo, 'a.txt', 'fix\n', 'the fix');
  sh(repo, 'push', '-qf', origin, 'HEAD:refs/pull/9/head');

  // RELAY_RESUME takes the sessions back after the restart.
  const R = await relay({ RELAY_UPDATE_DIR: dir, RELAY_RESUME: '1' }, home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const say = (sessionId, event) => R.hook({ hook_event_name: event, session_id: sessionId.slice(0, 12) });
  const update = async () => (await R.call('GET', '/update')).body;
  const typed = async (id) => (await R.screen(id)).split('GOT[' + BRIEF).length - 1;

  // A Dev in a turn, so the update waits for a quiet moment.
  const dev = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await say(dev.sessionId, 'UserPromptSubmit');
  commit(src, 'relay/x.js', '2\n', 'relay change'); sh(src, 'push', '-q', 'origin', 'main');
  const run = (await update()).run;
  const u = await R.call('POST', '/update', {});
  assert.strictEqual(u.status, 202, JSON.stringify(u.body));

  const started = await R.call('POST', '/checkouts', { from: repo, pr: PR, prompt: BRIEF });
  assert.strictEqual(started.status, 201, JSON.stringify(started.body));
  const reviewer = started.body;

  await t.test('the first prompt goes in while the update waits', async () => {
    await until(async () => (await typed(reviewer.id)) === 1, 'the reviewer to get its prompt while the update waits');
    const view = (await update()).update;
    assert.strictEqual(view && view.state, 'waiting', 'the update still waits for the Dev');
  });

  await t.test('the update waits for the review\'s turn as well as the Dev\'s', async () => {
    await say(reviewer.sessionId, 'UserPromptSubmit');
    await say(dev.sessionId, 'Stop');
    await sleep(1500);
    const view = (await update()).update;
    assert.ok(view && view.waitingOn.some((w) => w.terminal === reviewer.id && w.why === 'in a turn'), JSON.stringify(view));
  });

  await t.test('after the restart the reviewer is back, and its prompt is not typed again', async () => {
    await say(reviewer.sessionId, 'Stop');
    await until(async () => { try { return (await update()).run !== run; } catch (e) { return false; } }, 'the relay to restart', 200);
    const back = await until(async () => { try { return (await R.call('GET', '/terminals')).body.terminals.find((x) => x.sessionId === reviewer.sessionId); } catch (e) { return null; } }, 'the reviewer to come back');
    await sleep(2500);  // time for a prompt still owed to be typed
    assert.strictEqual(await typed(back.id), 1, 'typed once');
  });
});
