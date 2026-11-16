// The Lead marks a pull request ready to merge (T-107), so the person can tell from the PR itself, and
// from the PR list, that it has been through every review. See docs/manual/roles.html#ready.
//
// The Lead runs ticket.js ready <PR link> <head commit> with its note on stdin. The relay then:
//   - checks what it can check itself (relay/ready-plan.js refusal): the PR is open, its base is main, its
//     head is the commit the Lead named, its pipeline is green there, GitHub says it merges cleanly, and its
//     Dev has no merge hold (relay/merge-hold.js). The review and the findings are the Lead's to check,
//     and the note says how.
//   - posts one comment headed Ready to merge, with the head, who merges it and the Lead's note. It starts
//     with the ready mark, so relay/pr-comments.js does not pass it to the Dev as a review.
//   - adds the label "ready to merge", and makes the label first if the repo has none.
//   - keeps { head } for the PR in RELAY_READY_FILE. Every pipelinePollSeconds it asks gh for the PR's head
//     again. When a new commit lands, it takes the label off, so the label never points at an old head,
//     and says so in #office. The note stays as history. A PR that merged or closed, or whose label someone
//     took off, is no longer watched.
// Who merges is worked out from every file the PR changes or renames (gh api, paged, as Autopilot and the
// PR watch list them), Autopilot, and the Lead's merge switch, at the time the note is posted.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const state = require('./state.js');
const config = require('./config.js');
const chat = require('./chat.js');
const terminal = require('./terminal.js');
const tasks = require('./tasks.js');
const autopilot = require('./autopilot.js');
const plan = require('./ready-plan.js');
const { oneLine, keepLines } = require('./clean.js');
const { claim } = require('./lockfile.js');

const GH = process.env.GH_CMD || 'gh';
const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;
const SHA = /^[0-9a-f]{7,64}$/;
const MAX_TEXT = 20000;
const GUIDE = plan.guide(__dirname);
const FILE = state.file('ready.json', 'RELAY_READY_FILE');

let ctx = null;
const log = (text) => { if (ctx) ctx.log(text); };

const ownsFile = claim(FILE);
let store = {};
if (ownsFile) try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
  if (e.code !== 'ENOENT') console.error('Could not read ' + FILE + ', so no PR is watched for its ready to merge label: ' + e.message);
}
function save() {
  if (!ownsFile) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('Could not save ' + FILE + ': ' + e.message); }
}

function gh(args, input) {
  return new Promise((resolve) => {
    const child = execFile(GH, args, { timeout: 30000, maxBuffer: 16 * 1024 * 1024, env: Object.assign({}, process.env, { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }) }, (err, stdout, stderr) => {
      if (!err) { resolve({ out: String(stdout) }); return; }
      resolve({ failed: err.code === 'ENOENT' ? 'gh is not installed' : err.killed ? 'gh did not answer in time' : oneLine(stderr, 200) || 'gh failed' });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}
async function json(args) {
  const r = await gh(args);
  if (r.failed) return r;
  try { return { value: JSON.parse(r.out) }; } catch (e) { return { failed: 'gh sent something unreadable' }; }
}
const view = (pr, fields) => json(['pr', 'view', pr, '--json', fields]);
async function filesOf(pr) {
  const [, owner, repo, n] = pr.match(PR_URL);
  const r = await json(['api', '--paginate', '--slurp', 'repos/' + owner + '/' + repo + '/pulls/' + n + '/files?per_page=100']);
  if (r.failed) return r;
  return { value: [].concat(...r.value).flatMap((f) => [f && f.filename, f && f.previous_filename]).filter(Boolean) };
}
async function addLabel(pr) {
  const [, owner, repo] = pr.match(PR_URL);
  let r = await gh(['pr', 'edit', pr, '--add-label', plan.LABEL]);
  if (r.failed && /not found/i.test(r.failed)) {
    const made = await gh(['label', 'create', plan.LABEL, '--repo', owner + '/' + repo, '--color', plan.LABEL_COLOR, '--description', plan.LABEL_ABOUT]);
    if (made.failed && !/already exists/i.test(made.failed)) return made;
    r = await gh(['pr', 'edit', pr, '--add-label', plan.LABEL]);
  }
  return r;
}

function holdOf(channel, pr) {
  try {
    const row = require('./floor.js').floorOf(channel, Date.now()).find((s) => s.pr === pr && s.mergeHold);
    return row ? row.mergeHold : null;
  } catch (e) { return null; }
}
function whoOf(channel, pr, files) {
  const task = tasks.list(channel).find((t) => t.pr === pr && t.state !== 'done');
  const lead = terminal.leadOf(channel);
  return plan.whoMerges(files, {
    autopilot: !!(task && autopilot.movesIt(channel, task)),
    leadMerges: !!(lead && lead.merge && !autopilot.isOn(channel)),
  });
}

async function mark(channel, body, agent) {
  const pr = String(body.pr || '').trim(), head = String(body.head || '').trim().toLowerCase(), text = keepLines(body.text, MAX_TEXT + 1);
  if (!PR_URL.test(pr) || !SHA.test(head) || !text.trim()) return [400, { ok: false, error: 'bad_param', message: GUIDE }];
  if (text.length > MAX_TEXT) return [400, { ok: false, error: 'bad_param', message: 'The note is longer than ' + MAX_TEXT + ' characters. Make it shorter.' }];
  const missing = plan.missingParts(text);
  if (missing) return [400, { ok: false, error: 'bad_param', message: 'The note needs a line starting with each of: ' + missing.join(', ') + '.\n' + GUIDE }];
  const v = await view(pr, 'state,baseRefName,headRefOid,statusCheckRollup,mergeable');
  if (v.failed) return [502, { ok: false, error: 'gh', message: 'gh could not read ' + pr + ': ' + v.failed }];
  const why = plan.refusal(v.value, head, holdOf(channel, pr));
  if (why) return [409, { ok: false, error: 'not_ready', message: 'Not marked: ' + why }];
  const files = await filesOf(pr);
  if (files.failed) return [502, { ok: false, error: 'gh', message: 'gh could not list the files of ' + pr + ', so who merges it is not known: ' + files.failed }];
  const full = v.value.headRefOid;
  const who = whoOf(channel, pr, files.value);
  const posted = await gh(['pr', 'comment', pr, '--body-file', '-'], plan.noteOf({ head: full, who, text }));
  if (posted.failed) return [502, { ok: false, error: 'gh', message: 'gh could not post the note: ' + posted.failed }];
  const comment = oneLine(posted.out, 300);
  const labelled = await addLabel(pr);
  const marks = store[channel] || (store[channel] = {});
  marks[pr] = { head: full, at: new Date().toISOString(), comment };
  save();
  log((agent ? 'The Lead' : 'The person') + ' marked ' + pr + ' ready to merge at ' + full.slice(0, 7) + (labelled.failed ? ', but the label failed: ' + labelled.failed : '.'));
  if (labelled.failed) return [502, { ok: false, error: 'gh', comment, message: 'The note is posted (' + comment + '), but gh could not add the label: ' + labelled.failed }];
  return [200, { ok: true, pr, head: full, comment, label: plan.LABEL, who }];
}

let looking = false;
async function look() {
  if (looking) return;
  looking = true;
  try {
    for (const [channel, marks] of Object.entries(store)) {
      for (const [pr, m] of Object.entries(marks)) {
        const v = await view(pr, 'state,headRefOid,labels');
        if (v.failed) { if (m.problem !== v.failed) log('Could not ask gh about ' + pr + ', so its ready to merge label is checked again later: ' + v.failed); m.problem = v.failed; continue; }
        m.problem = null;
        const open = String(v.value.state || '').toUpperCase() === 'OPEN';
        const labelled = (v.value.labels || []).some((l) => l && l.name === plan.LABEL);
        if (!open || !labelled) { delete marks[pr]; save(); continue; }
        if (v.value.headRefOid === m.head) continue;
        const r = await gh(['pr', 'edit', pr, '--remove-label', plan.LABEL]);
        if (r.failed) { log('Could not take the ready to merge label off ' + pr + ': ' + r.failed); continue; }
        delete marks[pr]; save();
        const now = String(v.value.headRefOid).slice(0, 7);
        log('Took the ready to merge label off ' + pr + ': its head moved from ' + m.head.slice(0, 7) + ' to ' + now + '.');
        const task = tasks.list(channel).find((t) => t.pr === pr);
        chat.announce(channel, 'PR #' + pr.match(PR_URL)[3] + ' has a new commit, ' + now + ', after the Lead marked ' + m.head.slice(0, 7) + ' ready to merge, so the relay took its "' + plan.LABEL + '" label off. The note stays as history.', task && task.ticket);
      }
      if (!Object.keys(marks).length) { delete store[channel]; save(); }
    }
  } finally { looking = false; }
}

async function handle(req, res, channel, rest, rctx) {
  if (rest !== '/ready') return false;
  if (req.method !== 'POST') { rctx.problem(res, 404, 'not_found', 'Ready answers POST.'); return true; }
  const deny = terminal.localOnly(req, rctx.port);
  if (deny) { rctx.problem(res, 403, 'local_only', deny); return true; }
  const [status, out] = await mark(channel, await rctx.readJson(req), rctx.agent);
  rctx.send(res, status, out);
  return true;
}

function begin(relayCtx) {
  ctx = relayCtx;
  config.every('pipelinePollSeconds', () => { look().catch((e) => log('Checking the ready to merge labels failed: ' + e.message)); }, 5000);
}

module.exports = { handle, begin, look, mark, GUIDE };
