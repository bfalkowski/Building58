// A task's PR gets the label kind:<kind> of its ticket when the relay links the PR, with the GitHub ticket
// store. Through a real relay with a fake `claude` and a fake `gh`.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, removeDir, ROOT } = require('./helpers.js');

const PR = 'https://github.com/acme/widgets/pull/7';

test('a task\'s PR gets its ticket\'s kind label once the task links the PR, and a ticket with no kind adds none', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-')));
  const repo = makeRepo(home);
  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-')), issuesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-github-'));
  const R = await relay({ RELAY_WIP_LIMIT: '3', RELAY_TICKET_STORE: path.join(ROOT, 'relay', 'ticket-stores', 'github.js'), RELAY_TICKET_REPO: 't=o/r', RELAY_TICKET_FOLDER: repo, RELAY_TICKET_CACHE_MS: '0', GH_CMD: path.join(__dirname, 'fake-gh-both.js'), FAKE_GH_DIR: ghDir, FAKE_GITHUB_DIR: issuesDir }, home);
  t.after(async () => { await R.kill(); await R.remove(); removeDir(ghDir); removeDir(issuesDir); });
  const edited = () => { try { return fs.readFileSync(path.join(ghDir, 'edited.log'), 'utf8'); } catch (e) { return ''; } };
  const open = async (body, pr) => {
    const ticket = (await R.call('POST', '/tickets', Object.assign({ repo }, body))).body.ticket;
    const started = (await R.call('POST', '/tickets/' + ticket.id + '/start', {})).body.task;
    const task = await until(async () => { const x = (await R.call('GET', '/tasks/' + started.id)).body.task; return x.owner && x; }, 'the task\'s Dev');
    await R.hook({ hook_event_name: 'PostToolUse', session_id: task.owner.sessionId.slice(0, 12), tool_name: 'Bash', pr_url: pr });
    return task;
  };
  const none = await open({ title: 'Plain' }, 'https://github.com/acme/widgets/pull/8');
  await until(async () => (await R.call('GET', '/tasks/' + none.id)).body.task.pr, 'the task with no kind to link its PR');
  await open({ title: 'Fix it', kind: 'bug' }, PR);
  await until(() => edited().includes(PR + ' --add-label kind:bug'), 'the PR to get its kind label');
  assert.deepStrictEqual(edited().trim().split('\n'), [PR + ' --add-label kind:bug'], 'the earlier ticket, with no kind, added no label');
});
