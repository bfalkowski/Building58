// A job is a command a session's claude started that still runs, such as npm test in the background
// (relay/jobs.js). These check how a job is told from a helper, with command lines read from a real
// room on 2026-11-08, and that relay/liveness.js calls a session out of its turn with one busy.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isJob, parseEtime, parsePs, jobsUnder, LONG } = require('../jobs.js');
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
    '  100     1  07:48:10 node /x/relay/session-host.js /tmp/host.sock',
    '  200   100  07:48:10 python3 /x/relay/pty-bridge.py 120 32 claude --resume a',
    '  201   200  07:48:10 claude --resume a',
    '  300   201     02:21 ' + BASH_TOOL,
    '  301   300     02:21 npm test',
    '  302   201     02:36 caffeinate -i -t 300',
    '  303   201     00:01 ' + HOOK,
    '  400   100  07:48:10 python3 /x/relay/pty-bridge.py 120 32 claude --resume b',
    '  401   400  07:48:10 claude --resume b',
    '  500     1     03:00 ' + BASH_TOOL,
  ].join('\n'));
  assert.strictEqual(table.length, 10);
  assert.deepStrictEqual(table[4], { pid: 301, ppid: 300, ageMs: 141000, args: 'npm test' });
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
