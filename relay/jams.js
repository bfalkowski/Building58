// The jam log: a jam is a stall the room did not see, which the person (or their tools) fixed by hand, such
// as a PR with no first review or a task left in review after its PR merged. POST /jams writes one, GET /jams
// lists them, and Stalls by kind on the Metrics page counts them next to the stalls the room detected
// (relay/metrics-plan.js). The relay writes one itself for each push the push hold refuses (relay/autopilot.js),
// and one for each conflict hand-over of Autopilot, by 'autopilot': those are listed but not counted.
// Only the person's key writes or reads over HTTP: a session's token gets 403, except the Lead's, which may write
// a jam while Let the Lead unstick the board is on, always by: Lead, and the shared failure channels write one
// each by: room (relay/failures.js). A Lead jam says whether the Lead fixed it, passed it to the person or saw it
// and never acted (outcome), which the Metrics page's Lead section counts (relay/metrics-plan.js). They are kept
// 90 days in RELAY_JAMS_FILE (jams.json in the state folder). Text goes through oneLine, and a jam holds only
// a kind from KINDS, ids, times and one line about the fix. See docs/manual/how-it-works.html#metrics.
'use strict';
const fs = require('fs');
const path = require('path');
const state = require('./state.js');
const terminal = require('./terminal.js');
const { oneLine } = require('./clean.js');
const { claim } = require('./lockfile.js');
const config = require('./config.js');
const { rangeOf, RANGES, JAM_KINDS: KINDS } = require('./metrics-plan.js');

const KEEP_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;
const MAX_JAMS = 5000;
const ID = /^[\w.:/#-]{1,300}$/;
const FILE = state.file('jams.json', 'RELAY_JAMS_FILE');

let store = {};
try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
  if (e.code !== 'ENOENT') {
    const aside = FILE + '.unreadable-' + Date.now();
    try { fs.renameSync(FILE, aside); console.error('Could not read ' + FILE + '. Kept it as ' + aside); } catch (e2) { console.error('Could not read ' + FILE + ': ' + e.message); }
  }
}
const ownsFile = claim(FILE);
function save() {
  if (!ownsFile) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store) + '\n');
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('Could not save the jam log to ' + FILE + ': ' + e.message); }
}

function make(body, now) {
  const b = body && typeof body === 'object' ? body : {};
  const bad = (message) => ({ error: message });
  if (!Object.hasOwn(KINDS, b.kind)) return bad('kind is one of ' + Object.keys(KINDS).join(', ') + '.');
  const fix = typeof b.fix === 'string' ? oneLine(b.fix, 201) : '';
  if (!fix || fix.length > 200) return bad('fix is one line of 1 to 200 characters.');
  const by = b.by === undefined ? 'you' : typeof b.by === 'string' ? oneLine(b.by, 41) : '';
  if (!by || by.length > 40) return bad('by is 1 to 40 characters.');
  const outcome = b.outcome === undefined ? 'fixed' : b.outcome;
  if (!['fixed', 'passed', 'seen'].includes(outcome)) return bad('outcome is fixed, passed or seen.');
  if (b.blocked !== undefined && !(Number.isInteger(b.blocked) && b.blocked >= 0 && b.blocked <= 1000)) return bad('blocked is a count of PRs, 0 to 1000.');
  for (const k of ['ticket', 'pr']) if (b[k] !== undefined && !(typeof b[k] === 'string' && ID.test(b[k]))) return bad(k + ' is an id or an address with no spaces.');
  let since = null;
  if (b.since !== undefined) {
    const at = typeof b.since === 'string' && b.since.length <= 40 ? Date.parse(b.since) : NaN;
    if (!Number.isFinite(at) || at > now || at < now - KEEP_DAYS * DAY) return bad('since is an ISO time, not in the future and not over ' + KEEP_DAYS + ' days ago.');
    since = new Date(at).toISOString();
  }
  return { jam: Object.assign({ at: new Date(now).toISOString(), kind: b.kind, ticket: b.ticket || null, pr: b.pr || null, since, fix, by }, outcome !== 'fixed' ? { outcome } : {}, b.blocked !== undefined ? { blocked: b.blocked } : {}) };
}
function prune(list, now) {
  const from = now - KEEP_DAYS * DAY;
  return list.filter((j) => Date.parse(j.at) >= from).slice(-MAX_JAMS);
}
function record(channel, body) {
  const now = Date.now();
  let made = make(body, now);
  if (made.error) made = make({ kind: body.kind, fix: body.fix, by: body.by }, now);
  if (made.error) return null;
  store[channel] = prune((store[channel] || []).concat(made.jam), now);
  save();
  return made.jam;
}
terminal.onPromptAnswered((channel, t, known) => {
  record(channel, { kind: 'news-behind-menu', fix: oneLine('Closed Claude Code\'s own prompt "' + known.label + '" with "' + known.answer + '", so the news held behind its menu can go in.', 200), by: 'the relay' });
});
const listOf = (channel) => prune(store[channel] || [], Date.now());
const sinceRange = (range, now) => now - RANGES[range].days * DAY;

async function handle(req, res, channel, rest, ctx) {
  if (rest !== '/jams') return false;
  const deny = terminal.localOnly(req, ctx.port);
  if (deny) { ctx.problem(res, 403, 'local_only', deny); return true; }
  const leadWrites = ctx.agent && ctx.agent.lead && req.method === 'POST';
  if (ctx.agent && !leadWrites) { ctx.problem(res, 403, 'person_only', 'Only the person writes or reads the jam log.'); return true; }
  if (leadWrites && !config.get('leadUnstick')) { ctx.problem(res, 403, 'forbidden', 'The person has not let the Lead unstick the board, so only the person writes the jam log. They turn it on with Let the Lead unstick the board in Settings.'); return true; }
  const now = Date.now();
  if (req.method === 'POST') {
    let body = await ctx.readJson(req);
    if (leadWrites) {
      const stuck = require('./lead-stuck.js');
      body = Object.assign({}, body, { by: 'Lead', outcome: 'fixed' }, body && body.since === undefined && stuck.firstSeen(channel, body || {}) ? { since: new Date(stuck.firstSeen(channel, body)).toISOString() } : {}, { blocked: undefined });
      if (!body || typeof body !== 'object') body = {};
    }
    const made = make(body, now);
    if (made.error) { ctx.problem(res, 400, 'bad_param', made.error); return true; }
    store[channel] = prune((store[channel] || []).concat(made.jam), now);
    save();
    if (leadWrites) require('./lead-stuck.js').acted(channel, made.jam);
    ctx.send(res, 201, { ok: true, jam: made.jam });
    return true;
  }
  if (req.method !== 'GET') { ctx.problem(res, 404, 'not_found', 'Jams answers GET and POST only.'); return true; }
  const range = rangeOf(new URL(req.url, 'http://local').searchParams.get('range') || '7d');
  if (!range) { ctx.problem(res, 400, 'bad_param', 'range is 1d, 7d or 30d.'); return true; }
  const from = sinceRange(range, now);
  ctx.send(res, 200, { ok: true, range, keptDays: KEEP_DAYS, kinds: KINDS, jams: listOf(channel).filter((j) => Date.parse(j.at) >= from) });
  return true;
}

module.exports = { handle, listOf, record, make, prune, KINDS, KEEP_DAYS };
