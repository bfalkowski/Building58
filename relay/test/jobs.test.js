// A job is a command a session's claude started that still runs, such as npm test in the background
// (relay/jobs.js). These check how a job is told from a helper, with command lines read from a real
// room on 2026-11-08, and that relay/liveness.js calls a session out of its turn with one busy.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isJob, parseEtime, parsePs, jobsUnder, treeOf, commandOf, track, isStuck, end, LONG } = require('../jobs.js');
const { livenessOf } = require('../liveness.js');

const BASH_TOOL = '/bin/zsh -c source /Users/ada/.claude/shell-snapshots/snapshot-zsh-1794111846202-3o197b.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_NOMATCH && eval \'npm test\' < /dev/null && pwd -P >| /var/folders/x/T/claude-a1b2-cwd';
const HOOK = '/bin/sh -c OFFICE_RELAY_KEY=k OFFICE_RELAY_URL=http://localhost:8787 OFFICE_CHANNEL=office node /Users/ada/3d/relay/office-hook.js';

test('a shell from the Bash tool is a job, from its first second', () => {
  assert.strictEqual(isJob({ args: BASH_TOOL, ageMs: 0 }), true);
  assert.strictEqual(isJob({ args: '/bin/bash -c source /home/ada/.claude/shell-snapshots/snapshot-bash-1.sh && eval \'sleep 30\'', ageMs: 1000 }), true, 'bash on Linux');
  assert.strictEqual(isJob({ args: 'zsh -lc source /x/shell-snapshots/snapshot-zsh-1.sh', ageMs: 0 }), true, '-c among other options');
});

test('Claude Code\'s helpers and MCP servers are not jobs, however long they run', () => {
  for (const args of ['caffeinate -i -t 300', 'node /Users/ada/mcp/server.js', 'npx -y @modelcontextprotocol/server-filesystem /tmp',
    'uvx mcp-server-git', '/usr/bin/python3 -m some_mcp', 'docker run -i --rm mcp/github', 'sleep 30']) {
    assert.strictEqual(isJob({ args, ageMs: 10 * LONG }), false, args);
  }
});

test('a shell without -c, such as a subshell of the program itself, is not a job', () => {
  assert.strictEqual(isJob({ args: '/bin/bash /Users/ada/3d/relay/test/fake-claude.sh --session-id 1', ageMs: 10 * LONG }), false);
  assert.strictEqual(isJob({ args: '/bin/zsh', ageMs: 10 * LONG }), false);
  assert.strictEqual(isJob({ args: '/bin/bash /x/script.sh -c', ageMs: 10 * LONG }), false, '-c after the script is the script\'s');
});

test('a hook or status line command is a shell with -c, but a helper while it is young', () => {
  assert.strictEqual(isJob({ args: HOOK, ageMs: 2000 }), false);
  assert.strictEqual(isJob({ args: HOOK, ageMs: LONG }), true, 'one that runs that long counts, in case the snapshot is gone');
});

test('ps times read as milliseconds', () => {
  assert.strictEqual(parseEtime('00:04'), 4000);
  assert.strictEqual(parseEtime('02:30'), 150000);
  assert.strictEqual(parseEtime('07:37:14'), ((7 * 60 + 37) * 60 + 14) * 1000);
  assert.strictEqual(parseEtime('2-01:00:00'), (2 * 24 + 1) * 3600 * 1000);
  assert.strictEqual(parseEtime('nonsense'), 0);
});

test('a session\'s jobs are the jobs of the claude under its bridge, and no one else\'s', () => {
  const table = parsePs([
    '  100     1  07:48:10 00:00:00 node /x/relay/session-host.js /tmp/host.sock',
    '  200   100  07:48:10 00:00:00 python3 /x/relay/pty-bridge.py 120 32 claude --resume a',
    '  201   200  07:48:10 00:00:00 claude --resume a',
    '  300   201     02:21 00:00:00 ' + BASH_TOOL,
    '  301   300     02:21 00:00:00 npm test',
    '  302   201     02:36 00:00:00 caffeinate -i -t 300',
    '  303   201     00:01 00:00:00 ' + HOOK,
    '  400   100  07:48:10 00:00:00 python3 /x/relay/pty-bridge.py 120 32 claude --resume b',
    '  401   400  07:48:10 00:00:00 claude --resume b',
    '  500     1     03:00 00:00:00 ' + BASH_TOOL,
  ].join('\n'));
  assert.strictEqual(table.length, 10);
  assert.deepStrictEqual(table[4], { pid: 301, ppid: 300, ageMs: 141000, cpuMs: 0, args: 'npm test' });
  assert.deepStrictEqual(jobsUnder(table, 200), [{ pid: 300, ageMs: 141000 }], 'the Bash shell only: not its own children, caffeinate or a hook');
  assert.deepStrictEqual(jobsUnder(table, 400), [], 'an idle claude has none');
  assert.deepStrictEqual(jobsUnder(table, 999), [], 'a bridge that is gone has none');
});

const now = Date.parse('2026-11-08T04:00:00.000Z'), min = 60 * 1000;
const idle = (over) => Object.assign({ exited: false, stopped: false, state: 'idle', lastActAt: now - 5 * min, lastOutAt: now - 5 * min, stuck: null }, over);

test('out of a turn with a job still running: job since its turn ended, not idle', () => {
  assert.deepStrictEqual(livenessOf(idle({ jobs: { count: 1, since: now - 6 * min } }), now, 30 * min), { state: 'job', since: now - 5 * min, cause: null });
  assert.strictEqual(livenessOf(idle({ jobs: { count: 0, since: null } }), now, 30 * min).state, 'idle', 'its jobs ended');
  assert.strictEqual(livenessOf(idle({ jobs: null }), now, 30 * min).state, 'idle', 'nothing known of its jobs');
});

test('a job does not change the other states', () => {
  const jobs = { count: 2, since: now - min };
  assert.strictEqual(livenessOf(idle({ jobs, state: 'working', lastActAt: now - 1000 }), now, 30 * min).state, 'working');
  assert.strictEqual(livenessOf(idle({ jobs, state: 'waiting' }), now, 30 * min).state, 'waiting');
  assert.strictEqual(livenessOf(idle({ jobs, exited: true }), now, 30 * min).state, 'gone');
  assert.strictEqual(livenessOf(idle({ jobs, stuck: { at: now - min, why: 'x' } }), now, 30 * min).state, 'stuck', 'told and did not start');
});

const T0 = Date.parse('2026-11-25T08:00:00.000Z');
const walk = (samples) => samples.reduce((tracked, [at, sample]) => track(tracked, sample, T0 + at * min), null);

test('a job with no CPU and no output for 30 minutes is stuck, from a wait loop that spawns sleeps', () => {
  const loop = [];
  for (let m = 0; m <= 30; m++) loop.push([m, { cpus: { 300: 1000, [400 + m]: 0 }, size: 5000 }]);
  assert.strictEqual(isStuck(walk(loop.slice(0, 30)), T0 + 29 * min), false, '29 minutes quiet is not enough');
  assert.strictEqual(isStuck(walk(loop), T0 + 30 * min), true, '30 minutes quiet is stuck');
});

test('a job whose output file grows is not stuck, however little CPU it uses', () => {
  const slow = [];
  for (let m = 0; m <= 90; m++) slow.push([m, { cpus: { 300: 1000 }, size: 5000 + m }]);
  assert.strictEqual(isStuck(walk(slow), T0 + 90 * min), false);
});

test('a job that uses CPU is not stuck, even when its compilers come and go', () => {
  const build = [];
  for (let m = 0; m <= 90; m++) build.push([m, { cpus: { 300: 0, [500 + m]: 20000 }, size: 5000 }]);
  assert.strictEqual(isStuck(walk(build), T0 + 90 * min), false);
});

test('a job that goes quiet counts its 30 minutes from the last output, not from its start', () => {
  const run = [];
  for (let m = 0; m <= 40; m++) run.push([m, { cpus: { 300: 0 }, size: m <= 10 ? 100 + m : 111 }]);
  assert.strictEqual(isStuck(walk(run), T0 + 40 * min), false, '30 minutes after minute 10 is minute 40, and it is not yet');
  run.push([41, { cpus: { 300: 0 }, size: 111 }]);
  assert.strictEqual(isStuck(walk(run), T0 + 41 * min), true);
});

test('the command is the one line the Bash tool ran, not the shell\'s snapshot setup', () => {
  assert.strictEqual(commandOf(BASH_TOOL), 'npm test');
  assert.strictEqual(commandOf('/bin/bash -c source /h/.claude/shell-snapshots/snapshot-bash-1.sh && eval \'until grep -q "^# fail" /tmp/x.output; do sleep 3; done\' < /dev/null'), 'until grep -q "^# fail" /tmp/x.output; do sleep 3; done');
  assert.strictEqual(commandOf('/bin/bash -c source /h/s/snapshot-1.sh && eval \'a\nb\'\\\'\'c\''), "a b'c");
});

test('ending a job ends its own processes only, never the session, a helper or another session\'s job', () => {
  const table = parsePs([
    '  200   100  07:48:10 00:00:00 python3 /x/relay/pty-bridge.py 120 32 claude --resume a',
    '  201   200  07:48:10 00:00:00 claude --resume a',
    '  300   201     32:00 00:00:00 ' + BASH_TOOL,
    '  301   300     32:00 00:00:00 sleep 3',
    '  302   201     32:00 00:00:00 caffeinate -i -t 300',
    '  310   201     02:00 00:00:00 ' + BASH_TOOL,
    '  400   100  07:48:10 00:00:00 python3 /x/relay/pty-bridge.py 120 32 claude --resume b',
    '  401   400  07:48:10 00:00:00 claude --resume b',
    '  500   401     32:00 00:00:00 ' + BASH_TOOL,
  ].join('\n'));
  assert.deepStrictEqual(treeOf(table, 300).map((p) => p.pid), [300, 301]);
  const killed = [];
  const kill = (pid) => killed.push(pid);
  assert.strictEqual(end(table, 200, 201, kill), false, 'the claude is not a job');
  assert.strictEqual(end(table, 200, 302, kill), false, 'a helper is not a job');
  assert.strictEqual(end(table, 200, 500, kill), false, 'another session\'s job is not this session\'s');
  assert.strictEqual(end(table, 200, 9999, kill), false);
  assert.deepStrictEqual(killed, []);
  assert.strictEqual(end(table, 200, 300, kill), true);
  assert.deepStrictEqual(killed, [301, 300], 'the job and what it runs, children first');
});

test('a stuck job does not make a session busy: it is idle, and a job that works still does', () => {
  const stuck = { pid: 300, command: 'sleep 99999', since: now - 31 * min };
  assert.strictEqual(livenessOf(idle({ jobs: { count: 1, since: now - 40 * min, stuck: [stuck] } }), now, 30 * min).state, 'idle');
  assert.strictEqual(livenessOf(idle({ jobs: { count: 2, since: now - 40 * min, stuck: [stuck] } }), now, 30 * min).state, 'job', 'one stuck, one at work');
  assert.strictEqual(livenessOf(idle({ jobs: { count: 1, since: now - 40 * min, stuck: [] } }), now, 30 * min).state, 'job');
});
