'use strict';
// #office says when main moves on origin (relay/main-moves.js). Through a real relay whose Update
// folder is a clone of a fake origin: a bare repo on disk that the test pushes to.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep } = require('./helpers.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const push = (src, text) => {
  fs.appendFileSync(path.join(src, 'a.txt'), text + '\n');
  sh(src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', text);
  sh(src, 'push', '-q', 'origin', 'main');
  return sh(src, 'rev-parse', 'HEAD');
};
const moved = async (R) => (await R.call('GET', '/chat/office')).body.posts.map((p) => p.text).filter((t) => /moved/.test(t));
const watching = (R, sha) => until(() => R.output().includes('Watching main on origin at ' + sha.slice(0, 7)), 'the relay to look at origin', 100);

test('#office says once for each move of main on origin, and nothing at the start', async (t) => {
  const R0 = await relay({});
  const home = R0.home;
  await R0.kill();
  const src = makeRepo(home, 'src'), origin = path.join(home, 'origin.git'), dir = path.join(home, 'relay-folder');
  sh(home, 'clone', '-q', '--bare', src, origin); sh(home, 'clone', '-q', origin, dir); sh(src, 'remote', 'add', 'origin', origin);
  const env = { RELAY_UPDATE_DIR: dir, RELAY_MAIN_POLL_SECONDS: '1' };
  let R = await relay(env, home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });

  await R.call('GET', '/chat/office');  // the room's chat board exists, as it does once its page opens
  const start = sh(src, 'rev-parse', 'HEAD');
  await watching(R, start);
  await sleep(2500);  // two more looks at an origin that has not moved
  assert.deepStrictEqual(await moved(R), [], 'the first look is not news');

  const one = push(src, 'one');
  await until(async () => (await moved(R)).length === 1, 'the first move');
  assert.deepStrictEqual(await moved(R), ['main moved on origin, from ' + start.slice(0, 7) + ' to ' + one.slice(0, 7) + '.']);
  await sleep(2500);
  assert.strictEqual((await moved(R)).length, 1, 'one post for one move');

  const two = push(src, 'two');
  await until(async () => (await moved(R)).length === 2, 'the second move');
  assert.strictEqual((await moved(R))[1], 'main moved on origin, from ' + one.slice(0, 7) + ' to ' + two.slice(0, 7) + '.');

  // A move while no relay ran is where the next relay starts from, so it is not news either.
  await R.kill();
  const three = push(src, 'three');
  R = await relay(env, home);
  await watching(R, three);
  await sleep(2500);
  assert.strictEqual((await moved(R)).length, 2, 'nothing at the start of a new relay');
  const four = push(src, 'four');
  await until(async () => (await moved(R)).length === 3, 'a move after the restart');
  assert.strictEqual((await moved(R))[2], 'main moved on origin, from ' + three.slice(0, 7) + ' to ' + four.slice(0, 7) + '.');
});

test('when origin cannot be asked, the log says so once, and again when it answers', async (t) => {
  const R0 = await relay({});
  const home = R0.home;
  await R0.kill();
  const src = makeRepo(home, 'src'), origin = path.join(home, 'origin.git'), dir = path.join(home, 'relay-folder');
  sh(home, 'clone', '-q', src, dir); sh(dir, 'remote', 'set-url', 'origin', origin);  // an origin that is not there yet
  const R = await relay({ RELAY_UPDATE_DIR: dir, RELAY_MAIN_POLL_SECONDS: '1' }, home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const cannot = () => R.output().split('Cannot learn from origin where its default branch points').length - 1;
  await until(() => cannot() === 1, 'the log to say origin cannot be asked');
  await sleep(2500);  // two more looks that fail
  assert.strictEqual(cannot(), 1, 'said once, not at every look');

  sh(home, 'clone', '-q', '--bare', src, origin);
  await watching(R, sh(src, 'rev-parse', 'HEAD'));
  assert.ok(R.output().includes('Origin answers again.'));
  assert.strictEqual(cannot(), 1);
});
