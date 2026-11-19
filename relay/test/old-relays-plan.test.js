'use strict';
// Other relays on the room's state folder (relay/old-relays-plan.js), from a fake process list shaped like
// the one ps gave on 2026-11-19: a paused old copy of the main checkout with no worker left, a second room
// on its own folder, a test relay in another checkout, and the relay that runs now.
const test = require('node:test');
const assert = require('node:assert');
const { psOf, planOf } = require('../old-relays-plan.js');

const MAIN = '/u/repo/Building58/relay/server.js';
const NODE = '/opt/homebrew/bin/node';
const line = (pid, ppid, stat, started, command) => String(pid).padStart(5) + String(ppid).padStart(6) + ' ' + stat.padEnd(4) + ' ' + started + '     ' + command;
const LISTING = [
  '  PID  PPID STAT STARTED                      COMMAND',
  line(48435, 48146, 'T', 'Thu Nov 12 09:16:24 2026', NODE + ' ' + MAIN + ' HOME=/u PORT=8787 RELAY_TERMINAL=1 RELAY_WORLD=office'),
  line(48742, 48435, 'Ss', 'Thu Nov 12 09:16:24 2026', NODE + ' /u/repo/Building58/relay/session-host.js /tmp/office-host-a/host.sock HOME=/u'),
  line(28144, 28143, 'S', 'Wed Nov 18 13:45:42 2026', NODE + ' ' + MAIN + ' HOME=/u RELAY_STATE_DIR=/u/.office-world-c PORT=8791 RELAY_WORLD=office'),
  line(23800, 28144, 'S', 'Thu Nov 19 08:35:18 2026', NODE + ' ' + MAIN + ' HOME=/u RELAY_STATE_DIR=/u/.office-world-c PORT=8791 RELAY_WORLD=office RELAY_WORKER=1'),
  line(82841, 1, 'S', 'Fri Nov 13 04:11:48 2026', 'node relay/server.js HOME=/tmp/office-test-x PORT=53115 RELAY_TERMINAL=1'),
  line(82851, 82841, 'S', 'Fri Nov 13 04:11:48 2026', NODE + ' /u/repo/Building58/.worktrees/trailer/relay/server.js HOME=/tmp/office-test-x PORT=53115 RELAY_WORKER=1'),
  line(60312, 60305, 'S', 'Wed Nov 18 22:32:02 2026', NODE + ' ' + MAIN + ' HOME=/u PORT=8787 RELAY_WORLD=office'),
  line(30131, 60312, 'S', 'Thu Nov 19 07:53:47 2026', NODE + ' ' + MAIN + ' HOME=/u PORT=8787 RELAY_WORLD=office RELAY_WORKER=1 RELAY_SUPERVISED=1'),
  line(49365, 49285, 'S+', 'Thu Nov 12 09:16:24 2026', 'claude --resume 8ddf5358 HOME=/u RELAY_WORLD=office'),
].join('\n');
const ME = { pid: 30131, ppid: 60312, file: MAIN, stateDir: '/u/.office-world', port: 8787, defaultPort: 8787, world: 'office' };

test('psOf keeps only relay processes, with the few settings the plan reads', () => {
  const procs = psOf(LISTING);
  assert.deepStrictEqual(procs.map((p) => p.pid), [48435, 28144, 23800, 82841, 82851, 60312, 30131]);
  const old = procs[0];
  assert.strictEqual(old.ppid, 48146);
  assert.strictEqual(old.stat, 'T');
  assert.strictEqual(old.script, MAIN);
  assert.deepStrictEqual(old.env, { HOME: '/u', PORT: '8787', RELAY_WORLD: 'office' });
  assert.strictEqual(old.started, new Date(2026, 10, 12, 9, 16, 24).toISOString());
  assert.strictEqual(procs[3].script, 'relay/server.js', 'a relative path stays relative until the cwd is known');
});

test('the paused old copy of this relay is its own old copy, so it is stopped; the other room and the test relay are left alone', () => {
  const plan = planOf({ me: ME, procs: psOf(LISTING) });
  assert.deepStrictEqual(plan, [{ pid: 48435, pids: [48435], file: MAIN, port: 8787, started: new Date(2026, 10, 12, 9, 16, 24).toISOString(), paused: true, worker: false, own: true }]);
});

test('a relay from another checkout on this state folder is named, not stopped', () => {
  const listing = LISTING + '\n' + line(70001, 70000, 'S', 'Thu Nov 19 10:00:00 2026', NODE + ' /u/repo/Building58/.worktrees/t-9/relay/server.js HOME=/u PORT=8790') +
    '\n' + line(70002, 70001, 'S', 'Thu Nov 19 10:00:01 2026', NODE + ' /u/repo/Building58/.worktrees/t-9/relay/server.js HOME=/u PORT=8790 RELAY_WORKER=1');
  const other = planOf({ me: ME, procs: psOf(listing) }).find((r) => r.pid === 70001);
  assert.deepStrictEqual(other, { pid: 70001, pids: [70001, 70002], file: '/u/repo/Building58/.worktrees/t-9/relay/server.js', port: 8790, started: new Date(2026, 10, 19, 10, 0, 0).toISOString(), paused: false, worker: true, own: false });
});

test('the same checkout on another port shares the folder, so it is named, not stopped', () => {
  const listing = LISTING + '\n' + line(70003, 1, 'S', 'Thu Nov 19 10:00:00 2026', NODE + ' ' + MAIN + ' HOME=/u PORT=8788');
  assert.strictEqual(planOf({ me: ME, procs: psOf(listing) }).find((r) => r.pid === 70003).own, false);
});

test('a relay with no PORT runs on the default port, and a relative path is read against its cwd', () => {
  const listing = LISTING + '\n' + line(70004, 1, 'S', 'Thu Nov 19 10:00:00 2026', 'node relay/server.js HOME=/u');
  const procs = psOf(listing).map((p) => (p.pid === 70004 ? Object.assign(p, { cwd: '/u/repo/Building58' }) : p));
  const r = planOf({ me: ME, procs }).find((x) => x.pid === 70004);
  assert.strictEqual(r.file, MAIN);
  assert.strictEqual(r.port, 8787);
  assert.strictEqual(r.own, true);
  const unknown = planOf({ me: ME, procs: psOf(listing) }).find((x) => x.pid === 70004);
  assert.strictEqual(unknown.file, null);
  assert.strictEqual(unknown.own, false, 'with no cwd the checkout is unknown, so it is only named');
});

test('a ~ in RELAY_STATE_DIR is that relay\'s own HOME', () => {
  const listing = LISTING + '\n' + line(70005, 1, 'S', 'Thu Nov 19 10:00:00 2026', NODE + ' ' + MAIN + ' HOME=/u RELAY_STATE_DIR=~/.office-world PORT=8788');
  assert.ok(planOf({ me: ME, procs: psOf(listing) }).some((r) => r.pid === 70005));
});

test('a relay for another world, or one whose HOME ps does not show, is left alone', () => {
  const listing = LISTING + '\n' + line(70006, 1, 'S', 'Thu Nov 19 10:00:00 2026', NODE + ' ' + MAIN + ' HOME=/u PORT=8788 RELAY_WORLD=garden') +
    '\n' + line(70007, 1, 'S', 'Thu Nov 19 10:00:00 2026', NODE + ' ' + MAIN);
  const pids = planOf({ me: ME, procs: psOf(listing) }).map((r) => r.pid);
  assert.ok(!pids.includes(70006));
  assert.ok(!pids.includes(70007));
});

test('the relay that runs now, and its supervisor, are never in the plan', () => {
  const me = Object.assign({}, ME, { pid: 48435, ppid: 48146 });
  assert.ok(!planOf({ me, procs: psOf(LISTING) }).some((r) => r.pids.includes(48435)));
});
