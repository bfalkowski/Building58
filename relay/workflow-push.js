// A refused workflow push (494). GitHub refuses the room's App a push that creates or updates a file under
// .github/workflows, on purpose: main needs only the pipeline check, Autopilot merges for itself, release.yml
// publishes the image the server runs, and ci.yml runs on every push to any branch. So only the person pushes
// such a commit. The relay matches the refusal in a Dev's command (the hook sets workflow_refused, see
// relay/office-hook.js), keeps one item for the task, and Needs you shows it as Push this as you, with the
// branch, the commits GitHub does not have, the diff of each workflow file and the one command to run. While
// the item is open the task waits on the person, and Autopilot's stall clock does not run for it. A look every
// tick asks GitHub for the branch. When it reaches the commit, the item clears, the Dev is told, and the relay
// logs a workflows-push jam. See docs/manual/roles.html#workflows-push.
//
//   noteHook(channel, ev)       a hook event with workflow_refused opens the item for that session's task
//   open(channel, { task, terminal }) -> item   keeps one item for the task: { task, ticket, pr, title, terminal, sessionId, cwd, branch, commit, since, commits, files, command }
//   check(channel)              clears each item whose branch on GitHub has the commit
//   of(channel, id), waits(channel, id), reasonFor(channel, id, fallback), list(channel)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const state = require('./state.js');
const { oneLine, keepLines } = require('./clean.js');
const { claim } = require('./lockfile.js');

const REFUSAL = /refusing to allow a GitHub App to create or update workflow/i;
const WAITS = 'waits on the person: push';
const FILE = state.file('workflow-pushes.json', 'RELAY_WORKFLOW_PUSHES_FILE');
const { DIFF_LIMIT } = require('./needs-you-plan.js');
const FILES_LIMIT = 10, COMMITS_LIMIT = 20;
const ownsFile = claim(FILE);

let store = {};
function reload() {
  store = {};
  try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { store = {}; }
}
reload();
function save() {
  if (!ownsFile) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store) + '\n');
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('Could not save the workflow pushes to ' + FILE + ': ' + e.message); }
}
const chOf = (channel) => store[channel] || (store[channel] = {});

const refusedIn = (text) => REFUSAL.test(String(text || ''));

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 15000, maxBuffer: 4 * 1024 * 1024, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }) }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}
async function remoteSha(cwd, branch) {
  const out = await git(cwd, ['ls-remote', 'origin', 'refs/heads/' + branch]);
  return out ? out.split(/\s/)[0] : '';
}

async function inspect(cwd) {
  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const commit = await git(cwd, ['rev-parse', 'HEAD']);
  if (!branch || !commit || branch === 'HEAD') return null;
  const remote = await remoteSha(cwd, branch);
  const known = remote && (await git(cwd, ['cat-file', '-t', remote])) === 'commit';
  const from = known ? remote : (await git(cwd, ['rev-parse', '--verify', '-q', 'origin/' + branch])) || (await git(cwd, ['merge-base', 'HEAD', 'origin/main'])) || null;
  const range = from ? from + '..HEAD' : '-' + COMMITS_LIMIT;
  const log = (await git(cwd, ['log', '--format=%h%x09%s', '-n', String(COMMITS_LIMIT), range])) || '';
  const commits = log.split('\n').filter(Boolean).map((l) => ({ sha: oneLine(l.split('\t')[0], 12), subject: oneLine(l.split('\t').slice(1).join(' '), 200) }));
  const names = from ? (await git(cwd, ['diff', '--name-only', from, 'HEAD', '--', '.github/workflows'])) || '' : '';
  const files = [];
  for (const file of names.split('\n').filter(Boolean).slice(0, FILES_LIMIT)) {
    const diff = (await git(cwd, ['diff', from, 'HEAD', '--', file])) || '';
    files.push({ file: oneLine(file, 200), diff: keepLines(diff, DIFF_LIMIT) });
  }
  return { branch: oneLine(branch, 200), commit, commits, files };
}

const commandOf = (cwd, branch) => 'git -C ' + cwd + ' push origin ' + branch;

async function refresh(item) {
  const seen = await inspect(item.cwd);
  if (!seen) return false;
  Object.assign(item, seen, { command: commandOf(item.cwd, seen.branch) });
  save();
  return true;
}

async function open(channel, { task, terminal }) {
  const c = chOf(channel), have = c[task.id];
  if (have && have.cwd === terminal.cwd) { await refresh(have); return have; }
  const seen = await inspect(terminal.cwd);
  if (!seen) return null;
  const item = Object.assign({
    task: task.id, ticket: oneLine(task.ticket, 20) || null, pr: task.pr || null, title: oneLine(task.title, 120) || null,
    terminal: terminal.id, sessionId: terminal.sessionId || null, cwd: terminal.cwd, since: new Date().toISOString(),
  }, seen, { command: commandOf(terminal.cwd, seen.branch) });
  c[task.id] = item;
  save();
  return item;
}

const hooks = { taskOf: null, tell: null, jam: null };
function use(overrides) { Object.assign(hooks, overrides); }
function taskOf(channel, ev) {
  if (hooks.taskOf) return hooks.taskOf(channel, ev);
  const terminal = require('./terminal.js'), tasks = require('./tasks.js');
  const sid = String(ev.session_id || '');
  const t = sid && terminal.all(channel).find((x) => x.sessionId && x.sessionId.startsWith(sid));
  if (!t || !t.cwd) return null;
  const task = tasks.list(channel).find((x) => x.id === t.task || (x.owner && x.owner.terminal === t.id));
  return task ? { task, terminal: t } : null;
}
function noteHook(channel, ev) {
  if (!ev || !ev.workflow_refused) return;
  const found = taskOf(channel, ev);
  if (!found) return;
  open(channel, found).catch((e) => console.error('Could not look at the refused workflow push: ' + e.message));
}

function tell(channel, item) {
  const text = 'Your commit is on GitHub, no reset: the person pushed ' + item.branch + ' and GitHub now has ' + item.commit.slice(0, 7) + '. Carry on from your checkout as it is.';
  if (hooks.tell) return hooks.tell(channel, item, text);
  require('./delivery.js').save(channel, { key: 'workflow-push ' + item.task, terminal: item.terminal, sessionId: item.sessionId, text, expiresAt: Date.now() + 60 * 60 * 1000 });
}
function logJam(channel, item) {
  const jam = { kind: 'workflows-push', ticket: item.ticket || undefined, pr: item.pr || undefined, since: item.since, fix: oneLine('The person pushed ' + item.branch + ' as themselves: GitHub refuses the App a workflow file.', 200), by: 'the relay' };
  if (hooks.jam) return hooks.jam(channel, jam);
  require('./jams.js').record(channel, jam);
}

async function reached(item) {
  const remote = await remoteSha(item.cwd, item.branch);
  if (!remote) return false;
  if (remote === item.commit) return true;
  await git(item.cwd, ['fetch', '-q', 'origin', item.branch]);
  return (await git(item.cwd, ['merge-base', '--is-ancestor', item.commit, remote])) !== null;
}
async function check(channel) {
  const c = chOf(channel);
  for (const id of Object.keys(c)) {
    const item = c[id];
    if ((await git(item.cwd, ['rev-parse', 'HEAD'])) !== item.commit) await refresh(item);
    if (!(await reached(item))) continue;
    delete c[id];
    save();
    try { tell(channel, item); } catch (e) { console.error('Could not tell the Dev its commit is on GitHub: ' + e.message); }
    try { logJam(channel, item); } catch (e) { console.error('Could not log the workflows push: ' + e.message); }
  }
}

const of = (channel, id) => (store[channel] && store[channel][id]) || null;
const waits = (channel, id) => !!of(channel, id);
const reasonFor = (channel, id, fallback) => (waits(channel, id) ? WAITS : fallback);
const list = (channel) => Object.values(store[channel] || {});
function drop(channel, id) { if (store[channel]) { delete store[channel][id]; save(); } }
function forget(channel) {
  const tasks = require('./tasks.js'), open = new Set(tasks.list(channel).filter((t) => t.state !== 'done').map((t) => t.id));
  for (const id of Object.keys(chOf(channel))) if (!open.has(id)) drop(channel, id);
}
function begin() {
  require('./config.js').every('autopilotTickSeconds', () => {
    for (const channel of Object.keys(store)) { forget(channel); check(channel).catch((e) => console.error('Could not look at the workflow pushes: ' + e.message)); }
  });
}

module.exports = { REFUSAL, refusedIn, noteHook, open, check, of, waits, reasonFor, reasonOf: () => WAITS, list, drop, use, reload, begin };
