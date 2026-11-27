// A task PR that is red only on a known flaky test (T-500). Each pass looks at each open task PR whose checks failed on
// their head commit. If every failed check shows failing tests that an open flaky ticket names (a ticket of kind flaky
// or with the label flaky that names the test, or one whose title does), and the PR does not change that test's file,
// the relay reruns the failed job once (gh run rerun --failed), notes it on the flaky ticket with the PR, tells the
// room, and logs a flake-blocks jam by the relay. It never reruns a head twice. When that head fails again after a
// run that was not red, the PR goes to the shared failure channel (relay/failures.js) while Let the Lead unstick the
// board is on, and to Needs you otherwise. A new head starts over. The records are kept in RELAY_FLAKE_FILE
// (flake-reruns.json in the state folder), so a restart does not rerun a head again. See
// docs/manual/roles.html#flake-rerun.
'use strict';
const fs = require('fs');
const state = require('./state.js');
const config = require('./config.js');
const tasks = require('./tasks.js');
const chat = require('./chat.js');
const gh = require('./gh.js');
const jams = require('./jams.js');
const pipeline = require('./pipeline.js');
const failures = require('./failures.js');
const { oneLine } = require('./clean.js');
const plan = require('./flake-plan.js');

const FILE = state.file('flake-reruns.json', 'RELAY_FLAKE_FILE');
const MAX_LOG = 400000;
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const repoOf = (pr) => pr.split('/').slice(3, 5).join('/');
let recs = {};
try { recs = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { recs = {}; }
function save() { try { fs.mkdirSync(require('path').dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(recs)); } catch (e) { console.error('Flake reruns: could not save: ' + e.message); } }

const checked = new Map();
async function knownTicket(channel, pr, p) {
  const key = pr + '|' + p.head;
  if (checked.has(key)) return checked.get(key);
  const asked = (async () => {
    const tests = { names: [], files: [] };
    for (const f of p.failed) {
      const run = (f.url.match(/\/actions\/runs\/(\d+)/) || [])[1];
      if (!run) return null;
      const got = plan.testsOf((await gh.run(['run', 'view', run, '--log-failed', '-R', repoOf(pr)], { timeout: 60000 })).slice(-MAX_LOG));
      if (!got.names.length) return null;
      tests.names.push(...got.names); tests.files.push(...got.files);
    }
    tests.files = [...new Set(tests.files)];
    const task = tasks.list(channel).find((t) => t.pr === pr);
    const changed = (await gh.files(pr, p.head, task && task.repo)).map((f) => f.split('/').pop());
    if (tests.files.some((f) => changed.includes(f))) return null;
    const found = plan.knownBy(await require('./tickets.js').listAll(channel), tests);
    return found ? { id: found.id, tests: tests.names.slice(0, 3) } : null;
  })().catch((e) => { console.error('Flake check of ' + pr + ': ' + e.message); checked.delete(key); return null; });
  checked.set(key, asked);
  return asked;
}

const short = (head) => String(head || '').slice(0, 7);
const numberOf = (pr) => '#' + pr.split('/').pop();
async function rerun(channel, pr, p, found) {
  recs[pr] = { head: p.head, ticket: found.id, at: new Date().toISOString(), checks: p.failed.map((f) => f.name), seenNotRed: false, second: false };
  save();
  const got = await failures.rerunFailed(pr, p, p.failed);
  if (got.error || !got.done.length) { if (got.error) delete recs[pr]; save(); return; }
  pipeline.soon(pr);
  const checks = got.done.join(', '), test = found.tests.length ? ' (' + found.tests.map((t) => oneLine(t, 100)).join('; ') + ')' : '';
  const tickets = require('./tickets.js');
  await tickets.noteAsRelay(channel, found.id, 'PR ' + numberOf(pr) + ' went red on ' + short(p.head) + ' only on this known flake: check ' + checks + test + '. The relay reran the failed job once. A second failure on the same commit is not rerun.');
  jams.record(channel, { kind: 'flake-blocks', ticket: found.id, pr, by: 'the relay', fix: oneLine('Reran the failed job of ' + numberOf(pr) + ' once: ' + checks + '. Known flake, ticket ' + found.id + '.', 200) });
  chat.announce(channel, 'The relay reran the failed job of PR ' + numberOf(pr) + ' once: ' + checks + '. It is the known flake on ticket ' + found.id + '.');
}

async function second(channel, pr, p, rec) {
  if (rec.second) return;
  rec.second = true; save();
  const checks = rec.checks.join(', ');
  await require('./tickets.js').noteAsRelay(channel, rec.ticket, 'PR ' + numberOf(pr) + ' failed again on ' + short(p.head) + ' after the relay reran it once: check ' + checks + '. The relay does not rerun it again.');
  if (config.get('leadUnstick') && failures.shareFailure(channel, pr, rec.checks)) rec.shared = true;
  save();
  chat.announce(channel, 'PR ' + numberOf(pr) + ' failed again on ' + short(p.head) + ' after one rerun: ' + checks + '. ' + (rec.shared ? 'It went to the shared failure channel.' : 'It is on Needs you.'));
}

async function look(channel, task) {
  const pr = task.pr, p = pipeline.of(pr), rec = recs[pr];
  if (!p || p.open === false || !p.head) { if (rec) { delete recs[pr]; save(); } return; }
  if (rec && rec.head !== p.head) { delete recs[pr]; save(); return; }
  if (rec && p.state !== 'red' && !rec.seenNotRed) { rec.seenNotRed = true; save(); return; }
  if (p.state !== 'red' || !p.failed || !p.failed.length) return;
  if (rec) { if (rec.seenNotRed) await second(channel, pr, p, rec); return; }
  const found = await knownTicket(channel, pr, p);
  if (found) await rerun(channel, pr, p, found);
}

let sweeping = false;
async function sweep() {
  if (sweeping || gh.paused() || !pipeline.on()) return;
  sweeping = true;
  try {
    for (const channel of tasks.channels()) {
      for (const task of tasks.list(channel)) {
        if (!PR_URL.test(task.pr || '') || task.state === 'done') continue;
        try { await look(channel, task); } catch (e) { console.error('Flake rerun of ' + task.pr + ': ' + e.message); }
      }
    }
  } finally { sweeping = false; }
}

function waitingOf(channel) {
  const out = [];
  for (const task of tasks.list(channel)) {
    const rec = task.pr && recs[task.pr], p = rec && pipeline.of(task.pr);
    if (!rec || !rec.second || rec.shared || task.state === 'done' || !p || p.open === false || p.head !== rec.head || p.state !== 'red') continue;
    out.push({ pr: task.pr, checks: rec.checks, ticket: rec.ticket });
  }
  return out;
}

function begin() { config.every('chatPollSeconds', sweep, 1000); }

module.exports = { begin, sweep, look, waitingOf };
