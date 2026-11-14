// The security officer: when the person asks, a session reads what access the room's sessions run
// with and writes a one-page report with at most three recommendations. It frames the risk and says
// when to escalate, and it does not decide: it proposes only. See docs/manual/roles.html#security.
//
// The measures come from relay/access.js, names only. The last reports stay in security.json, each with
// the measures it was written from. A report that holds a key, or the value of a variable the measures
// name, is refused, so the report cannot carry a secret the session found.
//
// Like the terminal, this answers only the room page on this machine, while RELAY_TERMINAL=1.
'use strict';
const { keepLines } = require('./clean.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const state = require('./state.js');
const terminal = require('./terminal.js');
const delivery = require('./delivery.js');
const config = require('./config.js');
const access = require('./access.js');
const sessionEnv = require('./session-env.js');
const { claim } = require('./lockfile.js');
// The repo's secret check. Loaded when it is used, so a copy of the relay without .githooks still starts.
const secretCheck = () => { try { return require('../.githooks/check-secrets.js'); } catch (e) { return null; } };

const FILE = state.file('security.json', 'RELAY_SECURITY_FILE');
const GRACE = () => config.get('securityGraceSeconds') * 1000;  // after its report, its turn ends, then its desk is free
const MAX_REPORTS = 20, MAX_REPORT = 20000;
const ROOT = path.join(__dirname, '..');
const CLI = path.join(__dirname, 'ticket.js');

// ---------- the file: { channel: { reports } } ----------
let store = {};
try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
  if (e.code !== 'ENOENT') {  // keep a file we cannot read, rather than writing over it
    const aside = FILE + '.unreadable-' + Date.now();
    try { fs.renameSync(FILE, aside); console.error('Could not read ' + FILE + '. Kept it as ' + aside); } catch (e2) { /* nothing to keep */ }
  }
}
const ownsFile = claim(FILE);
function save() {
  if (!ownsFile) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('Could not save the security reports to ' + FILE + ': ' + e.message); }
}
function of(channel) {
  const s = store[channel] || (store[channel] = {});
  if (!Array.isArray(s.reports)) s.reports = [];
  return s;
}
const clean = keepLines;
const roleOf = (t) => (t.lead ? 'Lead' : t.role === 'pm' ? 'PM' : t.role === 'coo' ? 'COO' : t.role === 'security' ? 'Security' : t.role === 'reviewer' ? 'reviewer' : t.task ? 'Dev' : 'session');
const nameOf = (t) => clean(t.who || 'Session ' + String(t.sessionId).slice(0, 8), 80);

// ---------- the measures, from what this relay and this computer hold now ----------
function hookOn() {
  try { return execFileSync('git', ['-C', ROOT, 'config', 'core.hooksPath'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === '.githooks'; } catch (e) { return false; }
}
function scan() {
  const check = secretCheck();
  if (!check) return ['the check is not in the relay\'s folder (.githooks/check-secrets.js)'];
  try { return check.tracked(ROOT); } catch (e) { return ['the check could not read the tracked files']; }
}
function measuresOf(channel) {
  const live = terminal.all(channel).map((t) => ({ who: nameOf(t), role: roleOf(t), cwd: t.cwd, board: !!t.board, merge: !!t.merge, starts: t.starts || 0 }));
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  // process.env is what each session's environment is built from (relay/terminal.js).
  const measures = access.measure({ env: process.env, home: os.homedir(), root: ROOT, live, claude: access.claudeSettings(claudeDir), secretCheck: { hookOn: hookOn(), found: scan() } });
  const prev = of(channel).reports.slice(-1)[0] || null;
  return { measures, previous: prev ? { at: prev.at, gaps: (prev.measures && prev.measures.gaps) || [] } : null };
}

// ---------- the session ----------
// The brief is typed as one line, and macOS cuts a typed line at 1024 bytes (T-34), so it names
// ticket.js once and leaves the measures for the session to fetch.
function securityBrief() {
  return ('You are the security officer. You frame risk and say when to escalate; you do not decide. You propose only: change no code or access, open no PR, file no tickets, never start, stop or merge work or change a switch. ' +
    'Read CLAUDE.md and article 7 of docs/constitution.md. Run node "' + CLI + '" access. It gives names only, and so do you: never print or copy the value of a variable, token or key file. ' +
    'Write a one-page Markdown report: the logins sessions inherit, the folders they reach, what the relay takes out of their environment, what the secret check caught, against article 7, which rungs 3 and 4 wait for. ' +
    'Then at most 3 recommendations, each a ticket, limit or constitution change for the person to approve, with its evidence. Say what the measures cannot show. ' +
    require('./skills.js').brief('security') +
    'Then pipe the report into that command with access-report in place of access, and stop.')
    .replace(/\s+/g, ' ').trim();
}
const running = (channel) => terminal.all(channel).find((t) => t.role === 'security') || null;
function ask(channel, body, ctx) {
  const now = running(channel);
  if (now) return [409, { ok: false, error: 'running', message: 'The security officer is already writing a report.', terminal: now.id }];
  const r = terminal.start(channel, { cwd: ROOT, title: 'Security report', role: 'security', cols: body.cols, rows: body.rows }, ctx);
  if (r.status >= 400) return [r.status, r.body];
  delivery.promptOnce(channel, r.body.id, securityBrief(), (problem) => { if (problem) ctx.log('The security officer was not briefed: ' + problem); });
  return [201, { ok: true, terminal: r.body.id }];
}
// Its report is in. Once the turn that sent it ends, the session ends too (article 3), unless the
// person typed to it after the report.
function endAfterReport(t) {
  const talkedTo = () => !!(t.keyedAt && t.keyedAt > t.reportedAt);
  if (t.ending || t.exited || talkedTo()) return;
  t.ending = setTimeout(() => { t.ending = null; if (!talkedTo()) terminal.stop(t); }, GRACE());
}
function noteHook(channel, ev) {
  const sid = String((ev && ev.session_id) || '');
  if (!sid || ev.hook_event_name !== 'Stop') return;
  const t = terminal.all(channel).find((x) => x.role === 'security' && x.reportedAt && x.sessionId.startsWith(sid));
  if (t) endAfterReport(t);
}

// What a report must not hold: the relay's key, every session's token, and the value of each variable
// the measures name as looking like a login. Short values are left out, since they match ordinary words.
function secretsOf(channel, key) {
  const names = sessionEnv.names(process.env).loginLike;
  return [key].concat(terminal.all(channel).map((t) => t.token), names.map((n) => process.env[n])).filter((v) => typeof v === 'string' && v.length >= 8);
}
// Which kind of secret the text holds, and on which line, or null. Never the value itself.
function secretIn(text, secrets) {
  const check = secretCheck();
  if (!check) return { what: 'something the secret check could not look at, since it is not in the relay\'s folder', line: 1 };  // fail closed
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // The allow marker is for false alarms in the repo's own files. A report does not get it.
    const what = check.checkLine(lines[i], { allow: false }) || (secrets.some((v) => lines[i].includes(v)) ? 'a value of a key, token or login variable' : null);
    if (what) return { what, line: i + 1 };
  }
  return null;
}
function saveReport(channel, body, agent, ctx) {
  const text = clean(body.text, MAX_REPORT + 1).trim();
  if (!text) return [400, { ok: false, error: 'bad_report', message: 'The report is empty.' }];
  if (text.length > MAX_REPORT) return [400, { ok: false, error: 'bad_report', message: 'Keep the report to ' + MAX_REPORT + ' characters: one page.' }];
  const found = secretIn(text, secretsOf(channel, ctx.key));
  if (found) return [400, { ok: false, error: 'holds_a_secret', message: 'The report was not saved: line ' + found.line + ' looks like it holds ' + found.what + '. Name it, and leave its value out.' }];
  const { measures } = measuresOf(channel);
  const s = of(channel), report = { id: require('crypto').randomBytes(4).toString('hex'), at: new Date().toISOString(), by: agent ? nameOf(agent) : 'you', text, measures };
  s.reports.push(report);
  if (s.reports.length > MAX_REPORTS) s.reports.splice(0, s.reports.length - MAX_REPORTS);
  save();
  if (agent && agent.role === 'security') agent.reportedAt = Date.now();
  return [201, { ok: true, report: { id: report.id, at: report.at } }];
}
// The page asks often, so it gets the text, not the measures the report was written from.
const lastReport = (channel) => { const r = of(channel).reports, x = r[r.length - 1]; return x ? { id: x.id, at: x.at, by: x.by, text: x.text } : null; };

// ---------- routes under /channels/{channel}/security ----------
// The page has the key. The security officer's own token reads the measures and saves its report (relay/server.js).
async function handle(req, res, channel, rest, ctx) {
  const route = rest.match(/^\/security(?:\/(ask|measures|report))?$/);
  if (!route) { if (!/^\/security(\/|$)/.test(rest)) return false; ctx.problem(res, 404, 'not_found', 'Unknown security route.'); return true; }
  const deny = terminal.localOnly(req, ctx.port);
  if (deny) { ctx.problem(res, 403, 'local_only', deny); return true; }
  if (!terminal.ENABLED) { ctx.problem(res, 404, 'terminal_off', 'The security officer needs the terminal. Start the relay with npm run office, or with RELAY_TERMINAL=1.'); return true; }
  const verb = route[1];
  let out;
  if (!verb && req.method === 'GET') { const t = running(channel); out = [200, { ok: true, running: t ? t.id : null, report: lastReport(channel) }]; }
  else if (verb === 'measures' && req.method === 'GET') out = [200, Object.assign({ ok: true }, measuresOf(channel))];
  else if (verb === 'ask' && req.method === 'POST') out = ask(channel, await ctx.readJson(req), ctx);
  else if (verb === 'report' && req.method === 'POST') out = saveReport(channel, await ctx.readJson(req), ctx.agent, ctx);
  if (!out) { ctx.problem(res, 404, 'not_found', 'Unknown security route.'); return true; }
  ctx.send(res, out[0], out[1]);
  return true;
}

module.exports = { handle, noteHook, securityBrief };
