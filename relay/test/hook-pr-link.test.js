// How the hook (relay/office-hook.js) tells the relay a Dev opened a pull request: only when gh pr create
// really ran, and only from a line that is the link alone, as gh prints it. A Dev that reads code or tests
// which mention gh pr create, or hold a sample link, opens no pull request. In the container trial a Dev
// ran grep "gh pr create" with sed of a test file, and the room took https://github.com/acme/widgets/pull/7,
// a link from the tests, as its task's pull request.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { prMade, summarize } = require('../office-hook.js');

const REAL = 'https://github.com/bfalkowski/Building58/pull/320';
const FAKE = 'https://github.com/acme/widgets/pull/7';

test('gh pr create that runs gives its pull request', () => {
  assert.strictEqual(prMade('gh pr create --title "T-1: x" --body-file b.md', { stdout: REAL + '\n' }), REAL);
  assert.strictEqual(prMade('git push -u origin HEAD && gh pr create --fill', { stdout: 'Creating pull request\n' + REAL + '\n' }), REAL);
  assert.strictEqual(prMade('cd /w/repo; GH_PROMPT_DISABLED=1 gh pr create --fill 2>&1 | tail -1', { stdout: REAL }), REAL);
  assert.strictEqual(prMade('gh pr create --fill', REAL + '\r\n'), REAL, 'a plain string, with a carriage return');
});

test('a command that only mentions gh pr create opens no pull request', () => {
  const cmd = 'sed -n 1,70p test/pr-watch.test.js; grep -n "pr-watch\\|how a task\\|gh pr create" ../docs/manual/roles.html | head -20';
  assert.strictEqual(prMade(cmd, { stdout: "12:const PR = '" + FAKE + "';\n" + FAKE + '\n' }), null);
  assert.strictEqual(prMade('echo "run gh pr create next"', { stdout: REAL }), null);
  assert.strictEqual(prMade("rg 'gh pr create' relay/", { stdout: REAL }), null);
});

test('a link inside a longer line is not the pull request', () => {
  assert.strictEqual(prMade('gh pr create --fill', { stdout: 'warning: see ' + FAKE + ' for help\n' }), null);
  assert.strictEqual(prMade('gh pr create --fill', { stdout: "const PR = '" + FAKE + "';\n" + REAL + '\n' }), REAL);
});

test('the hook event carries pr_url only for a real gh pr create', () => {
  const ev = (command, stdout) => summarize({ hook_event_name: 'PostToolUse', session_id: 's', cwd: '/w', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '' } });
  assert.strictEqual(ev('gh pr create --fill', REAL + '\n').pr_url, REAL);
  assert.strictEqual(ev('grep -rn "gh pr create" relay', "x.js:3: const PR = '" + FAKE + "'\n").pr_url, undefined);
});
