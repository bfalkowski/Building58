// Main's CI: whether the last CI run on main passed, for each repo this room works in. Two PRs that each
// pass can break main when they merge minutes apart, so CI runs on each push to main, and a red main is
// shown where the person and the Lead look. See docs/manual/roles.html#red-main.
//
// Every mainCiPollSeconds (Settings, 120) the relay asks gh run list --branch <base> --event push once for
// each repo and base branch that a task of this room uses, and for each one Autopilot is about to start a
// ticket in. It keeps the last answer in memory, and asks again about a branch only once that answer is
// mainCiPollSeconds old. For each workflow it takes the newest finished run that a push started and that
// was not cancelled. Weekly and by-hand runs test more, such as Node 18, so they do not count. Main is
//   red      the newest such run of a workflow failed, timed out or could not start
//   green    every workflow's newest such run passed, or was skipped or neutral
//   none     there is no such run yet
//   unknown  gh did not answer, or sent something unreadable
// Only red holds anything back: Needs you shows it with the failed run's link (relay/needs-you-plan.js), the
// Lead's Floor shows it (relay/floor.js), and Autopilot starts no new ticket on that base branch (relay/autopilot.js).
// A run that is still going changes nothing, so main stays red until a run passes.
'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config.js');
const { oneLine } = require('./clean.js');

const GH = process.env.GH_CMD || 'gh';
const RED = ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE'];
const OK = ['SUCCESS', 'SKIPPED', 'NEUTRAL'];
const FIELDS = 'databaseId,workflowName,status,conclusion,url,headSha,event,createdAt';
const up = (x) => String(x || '').toUpperCase();

function stateOf(runs) {
  if (!Array.isArray(runs)) return { state: 'unknown', error: 'gh sent something unreadable' };
  const newest = new Map();
  const done = runs.filter((r) => r && r.event === 'push' && up(r.status) === 'COMPLETED' && (RED.includes(up(r.conclusion)) || OK.includes(up(r.conclusion))))
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  for (const r of done) if (!newest.has(r.workflowName || '')) newest.set(r.workflowName || '', r);
  if (!newest.size) return { state: 'none' };
  const failed = [...newest.values()].find((r) => RED.includes(up(r.conclusion)));
  if (!failed) return { state: 'green' };
  return { state: 'red', run: { workflow: oneLine(failed.workflowName, 80) || 'CI', sha: oneLine(failed.headSha, 64), url: oneLine(failed.url, 300), conclusion: String(failed.conclusion || '').toLowerCase() } };
}

const keyOf = (repo, branch) => repo + '\n' + branch;
const seen = new Map();
const wanted = new Map();
const on = () => config.get('mainCiPollSeconds') > 0;

function list(repo, branch) {
  return new Promise((resolve) => {
    execFile(GH, ['run', 'list', '--branch', branch, '--event', 'push', '--limit', '20', '--json', FIELDS], { cwd: repo && fs.existsSync(repo) ? repo : os.homedir(), timeout: 20000, env: Object.assign({}, process.env, { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }) }, (err, stdout, stderr) => {
      if (err) { resolve({ state: 'unknown', error: err.code === 'ENOENT' ? 'gh is not installed' : String(stderr || err.message).trim().split('\n')[0].slice(0, 160) || 'gh failed' }); return; }
      try { resolve(stateOf(JSON.parse(stdout))); } catch (e) { resolve({ state: 'unknown', error: 'gh sent something unreadable' }); }
    });
  });
}
const asking = new Map();
function ask(repo, branch) {
  const key = keyOf(repo, branch);
  if (asking.has(key)) return asking.get(key);
  const done = list(repo, branch).then((now) => {
    const was = seen.get(key);
    if (now.state === 'red' && (!was || was.state !== 'red')) console.log(new Date().toISOString().slice(11, 19), 'Main is red: ' + branch + ' in ' + repo + ', ' + now.run.workflow + ' ' + now.run.url);
    if (was && was.state === 'red' && now.state === 'green') console.log(new Date().toISOString().slice(11, 19), 'Main is green again: ' + branch + ' in ' + repo + '.');
    seen.set(key, Object.assign(now, { repo, branch, at: Date.now() }));
    return seen.get(key);
  }).finally(() => asking.delete(key));
  asking.set(key, done);
  return done;
}

function reposOf(channel) {
  const out = new Map();
  for (const t of require('./tasks.js').list(channel)) if (t.repo && t.base) out.set(keyOf(t.repo, t.base), [t.repo, t.base]);
  for (const [key, pair] of wanted.get(channel) || []) out.set(key, pair);
  return out;
}

const fresh = (key) => { const was = seen.get(key); return was && Date.now() - was.at < config.get('mainCiPollSeconds') * 1000 ? was : null; };
async function check(channel, repo, branch) {
  if (!on() || !repo || !branch) return null;
  const key = keyOf(repo, branch);
  if (!wanted.has(channel)) wanted.set(channel, new Map());
  wanted.get(channel).set(key, [repo, branch]);
  return fresh(key) || ask(repo, branch);
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const all = new Map();
    for (const channel of require('./tasks.js').channels()) for (const [key, pair] of reposOf(channel)) all.set(key, pair);
    for (const key of seen.keys()) if (!all.has(key)) seen.delete(key);
    for (const [key, [repo, branch]] of all) if (!fresh(key)) await ask(repo, branch);
  } finally { polling = false; }
}
config.every('mainCiPollSeconds', () => { poll().catch((e) => console.error('Main CI: ' + e.message)); }, 5000);

function redOf(channel) {
  if (!on()) return [];
  const out = [];
  for (const key of reposOf(channel).keys()) {
    const s = seen.get(key);
    if (s && s.state === 'red') out.push({ repo: s.repo, name: path.basename(s.repo), branch: s.branch, run: s.run });
  }
  return out;
}

module.exports = { stateOf, check, poll, redOf };
