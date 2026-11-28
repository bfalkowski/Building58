'use strict';
// A refused workflow push (494). GitHub refuses the room's App a push that creates or updates a workflow file.
// On 2026-11-25 the Dev's fix for ticket 435 sat committed and unpushed for about 4 hours, twice, and only the
// Dev's chat said why. The relay matches the refusal, Needs you says Push this as you, the stall clock stops,
// and the item clears and a jam is logged once the branch on GitHub reaches the commit.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-workflow-push-')));
process.env.RELAY_STATE_DIR = path.join(home, 'state');
const wp = require('../workflow-push.js');
const { listOf } = require('../needs-you-plan.js');
const { summarize } = require('../office-hook.js');

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t'].concat(args), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const REFUSAL = "! [remote rejected] HEAD -> task/x (refusing to allow a GitHub App to create or update workflow `.github/workflows/exhibit.yml` without `workflows` permission)";
const PR = 'https://github.com/o/r/pull/12';

function rig() {
  const origin = path.join(home, 'origin-' + Math.random().toString(36).slice(2) + '.git'), dev = origin.replace('.git', '-dev');
  sh(home, 'init', '-q', '--bare', origin);
  sh(home, 'clone', '-q', origin, dev);
  sh(dev, 'checkout', '-q', '-b', 'task/x');
  fs.writeFileSync(path.join(dev, 'a.txt'), 'a\n');
  sh(dev, 'add', '.'); sh(dev, 'commit', '-qm', 'first');
  sh(dev, 'push', '-q', 'origin', 'task/x');
  fs.mkdirSync(path.join(dev, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(dev, '.github', 'workflows', 'exhibit.yml'), 'name: exhibit\non: push\n');
  sh(dev, 'add', '.'); sh(dev, 'commit', '-qm', 'Fix the exhibit workflow');
  return { origin, dev, head: sh(dev, 'rev-parse', 'HEAD') };
}
const told = [], logged = [];
const there = (r) => ({ task: { id: 'k1', ticket: '435', pr: PR, title: 'Exhibit' }, terminal: { id: 'aaaaaaaaaaaa', sessionId: 'sess-1', cwd: r.dev } });
wp.use({ taskOf: () => null, tell: (channel, item, text) => told.push({ item: item.task, text }), jam: (channel, jam) => logged.push(jam) });

test('the hook marks a refused push, in a failed command or a push that printed the refusal', () => {
  const failed = summarize({ hook_event_name: 'PostToolUseFailure', session_id: 's', tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' }, error: 'Exit code 1\nremote: ' + REFUSAL });
  assert.strictEqual(failed.workflow_refused, true);
  const quiet = summarize({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'git push origin HEAD 2>&1 || true' }, tool_response: { stdout: REFUSAL, stderr: '' } });
  assert.strictEqual(quiet.workflow_refused, true);
  const read = summarize({ hook_event_name: 'PostToolUseFailure', session_id: 's', tool_name: 'Bash', tool_input: { command: 'grep -rn "refusing to allow" docs' }, error: 'Exit code 1\n' + REFUSAL });
  assert.strictEqual(read.workflow_refused, undefined, 'a command that only reads the words is not a refused push');
  const other = summarize({ hook_event_name: 'PostToolUseFailure', session_id: 's', tool_name: 'Bash', tool_input: { command: 'git push' }, error: 'Exit code 1\nremote: Permission denied' });
  assert.strictEqual(other.workflow_refused, undefined);
});

test('a failed Dev command with the refusal text makes a Push this as you item, and the task waits on the person', async () => {
  const r = rig(), at = there(r);
  const item = await wp.open('office', at);
  assert.strictEqual(item.branch, 'task/x');
  assert.strictEqual(item.commit, r.head);
  assert.deepStrictEqual(item.commits.map((c) => c.subject), ['Fix the exhibit workflow']);
  assert.strictEqual(item.files.length, 1);
  assert.strictEqual(item.files[0].file, '.github/workflows/exhibit.yml');
  assert.match(item.files[0].diff, /\+name: exhibit/);
  assert.strictEqual(item.command, 'git -C ' + r.dev + ' push origin task/x');
  assert.strictEqual(wp.reasonOf(item), 'waits on the person: push');

  const [it, ...rest] = listOf({ seats: [], tasks: [Object.assign({ id: 'k1', ticket: '435', title: 'Exhibit', state: 'building', pr: PR, prOpen: true, owner: null, workflowPush: item })] });
  assert.deepStrictEqual(rest, []);
  assert.strictEqual(it.kind, 'workflow-push');
  assert.match(it.line, /^Push this as you: 435 /);
  assert.ok(it.line.includes('task/x') && it.line.includes(r.command || item.command));
  assert.deepStrictEqual(it.commits, item.commits);
  assert.match(it.files[0].diff, /\+name: exhibit/);
  assert.strictEqual(wp.of('office', 'k1').branch, 'task/x');
  assert.strictEqual(wp.waits('office', 'k1'), true, 'the stall clock does not run');
  assert.strictEqual(wp.waits('office', 'other'), false);
  wp.drop('office', 'k1');
});

test('the item clears and a workflows-push jam is logged when the branch on GitHub reaches the commit', async () => {
  const r = rig(), at = there(r);
  told.length = 0; logged.length = 0;
  const item = await wp.open('office', at);
  await wp.check('office');
  assert.ok(wp.of('office', 'k1'), 'still open while the branch on GitHub is behind');
  assert.strictEqual(logged.length, 0);
  sh(r.dev, 'push', '-q', 'origin', 'task/x');
  await wp.check('office');
  assert.strictEqual(wp.of('office', 'k1'), null);
  assert.strictEqual(wp.waits('office', 'k1'), false);
  assert.strictEqual(told.length, 1);
  assert.match(told[0].text, /^Your commit is on GitHub, no reset/);
  assert.strictEqual(logged.length, 1);
  assert.strictEqual(logged[0].kind, 'workflows-push');
  assert.strictEqual(logged[0].by, 'the relay');
  assert.strictEqual(logged[0].since, item.since);
  assert.strictEqual(logged[0].ticket, '435');
  await wp.check('office');
  assert.strictEqual(logged.length, 1, 'logged once');
});

test('an open item is kept across a relay restart', async () => {
  const r = rig(), at = there(r);
  await wp.open('office', at);
  wp.reload();
  assert.strictEqual(wp.of('office', 'k1').branch, 'task/x');
  wp.drop('office', 'k1');
});

test('a task with an open item gets no stall hand-over, and Autopilot says it waits on the person', async () => {
  const plan = require('../autopilot-plan.js');
  const idle = { devBusy: false, reviewing: false, waitsOnCi: false, waitsForDesk: false };
  assert.strictEqual(plan.stalls(Object.assign({ waitsOnPerson: false }, idle)), true);
  assert.strictEqual(plan.stalls(Object.assign({ waitsOnPerson: true }, idle)), false);
  assert.strictEqual(plan.stalls(Object.assign({ waitsOnPerson: false, bringBack: true }, idle)), false, 'main\'s bring-back also stops the stall');
  const r = rig();
  await wp.open('office', there(r));
  assert.strictEqual(wp.reasonFor('office', 'k1', 'The Dev is fixing what the last review found.'), 'waits on the person: push');
  assert.strictEqual(wp.reasonFor('office', 'zz', 'keeps its own'), 'keeps its own');
  wp.drop('office', 'k1');
});

test('a commit the Dev amends after the refusal refreshes the item, and the item clears once the new commit is on GitHub', async () => {
  const r = rig(), at = there(r);
  logged.length = 0;
  const item = await wp.open('office', at);
  assert.strictEqual(item.commit, r.head);
  fs.appendFileSync(path.join(r.dev, '.github', 'workflows', 'exhibit.yml'), 'jobs: {}\n');
  sh(r.dev, 'commit', '-qa', '--amend', '-m', 'Fix the exhibit workflow again');
  const amended = sh(r.dev, 'rev-parse', 'HEAD');
  await wp.check('office');
  const now = wp.of('office', 'k1');
  assert.strictEqual(now.commit, amended, 'the item follows the Dev\'s HEAD');
  assert.match(now.files[0].diff, /\+jobs: \{\}/);
  assert.strictEqual(now.since, item.since);
  sh(r.dev, 'push', '-q', 'origin', 'task/x');
  await wp.check('office');
  assert.strictEqual(wp.of('office', 'k1'), null);
  assert.strictEqual(logged.length, 1);
});

test('the Lead\'s look says the person pushes the workflow file, and what the task waits on', () => {
  const { lineOf, waitingOn } = require('../huddles.js');
  const row = { who: 'Ada', ticket: '435', title: 'Exhibit', status: 'finished', taskState: 'building', pr: null, git: { branch: 'task/x', pushed: true, changed: 0, ahead: 1 }, waitingOn: null, lastSeconds: null, workflowPush: true };
  assert.strictEqual(waitingOn(row, {}).on, 'you: push the workflow file');
  assert.strictEqual(waitingOn(Object.assign({}, row, { workflowPush: false }), {}).on !== 'you: push the workflow file', true);
  row.waitingOn = waitingOn(row, {}).on;
  assert.match(lineOf(row), /1 unpushed \(GitHub refuses the App a workflow file, so the person pushes it\)/);
  assert.doesNotMatch(lineOf(Object.assign({}, row, { workflowPush: false })), /refuses the App/);
});

test('the hook and the relay match the same refusal text', () => {
  for (const said of [REFUSAL, 'remote: refusing to allow a GitHub App to create or update workflow `x.yml` without `workflows` permission']) {
    assert.strictEqual(wp.refusedIn(said), true);
    assert.strictEqual(summarize({ hook_event_name: 'PostToolUseFailure', session_id: 's', tool_name: 'Bash', tool_input: { command: 'git push' }, error: said }).workflow_refused, true);
  }
  assert.strictEqual(wp.refusedIn('remote: Permission denied'), false);
});
