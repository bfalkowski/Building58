// Games: the room acts out a game from another repo for one round. The room does not change, only
// the roles of the sessions in it. A game is a folder in GAMES_REPO with a game.json:
//   { name, version, api, entry, players: { min, max }, needs }
// This file never names a game. It knows the calls every game answers, and nothing else.
//
// A round runs the game as its own child process (node <entry>, in the game's folder), and they talk
// in JSON lines on its standard input and output. The relay sends:
//   hello { api }, setup { seed, settings, seats }, action { id, seat, kind, args }, finish, abort
// The game sends:
//   hello { api }, brief { seat, text }, ready, answer { id, text }, spend { usd }, done { score, reveal }
//
// Each seat is a fresh session at a free desk, in a new folder of its own under the state folder that
// is not a copy of a repo, with no task. The person may answer its question about trusting that folder,
// and type nothing else into it. A seat is saved with its round's id, so a relay that restarts brings
// no seat back (relay/sessions.js): a round never outlives the relay that ran it. Its brief is typed as its first prompt and kept nowhere: not in a file, a log, a title
// or a route. A seat acts only as itself, with its own token, through POST /play (relay/play.js), and
// that is all its token reaches (relay/server.js). The relay has no field for a role: the game alone
// knows who is what, and says so in its reveal at the end.
//
// A round ends with finish (the game's score and reveal), with stop (no score), or when the game fails:
// it exits, sends a line that is not JSON, stops answering for RELAY_GAME_TIMEOUT_MS (30 seconds), or
// the round reaches its spend cap. Then the relay stops every seat and removes the seat folders. The
// room keeps only each round's id, game, time and score, in memory.
//
// While a round runs, the Lead and Autopilot start no new tickets (relay/tickets.js), and the person
// cannot type into a seat. A round is Watch all (the default): the person can open any seat's screen.
// Or Watch none, for when the person plays too: seat screens are refused until the round ends.
//
// Routes, on a channel, with the relay key:
//   GET  /games                    the games found, with ok and a reason for each
//   POST /rounds                   { game, seed, settings, seats, watch, capUsd } starts a round
//   GET  /rounds/current           the round that runs, or null
//   POST /rounds/current/finish    asks the game for its score and reveal
//   POST /rounds/current/stop      ends the round with no score
//   GET  /rounds                   past rounds: id, game, time and score only
// And with a seat's own token:
//   POST /play                     { kind, args } one action for that seat. The answer comes back.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const terminal = require('./terminal.js');
const tickets = require('./tickets.js');
const sessionEnv = require('./session-env.js');

const API = 1;
// What a game may ask of the room, and the part of it this version can do.
const NEEDS = ['privateBriefs', 'ask', 'files', 'transcript', 'chat', 'phases', 'votes', 'turns', 'sandboxRepo', 'personSeat', 'gameMaster'];
const CAN = ['privateBriefs', 'ask', 'files'];
const WATCH = ['all', 'none'];
const TIMEOUT = () => (Number(process.env.RELAY_GAME_TIMEOUT_MS) >= 1 ? Number(process.env.RELAY_GAME_TIMEOUT_MS) : 30000);
const BRIEF_RETRY = 300, BRIEF_GIVE_UP = 10 * 60 * 1000;  // a seat may wait on a question, such as trusting its folder
const KEEP_PAST = 50;

const roundSeats = require('./round-seats.js');

const repo = () => process.env.GAMES_REPO || '';
const seatsDir = roundSeats.dir;
const rounds = new Map();  // channel: the round that runs
const past = new Map();    // channel: [{ id, game, time, score }], newest first

// Every folder in GAMES_REPO with a game.json, with whether the loader can run it and why not.
function listGames() {
  const root = repo();
  if (!root) return [];
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return []; }
  return dirs.filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name).sort()
    .filter((dir) => fs.existsSync(path.join(root, dir, 'game.json'))).map((dir) => readGame(root, dir));
}
function readGame(root, folder) {
  const out = { folder, ok: false };
  let g;
  try { g = JSON.parse(fs.readFileSync(path.join(root, folder, 'game.json'), 'utf8')); } catch (e) { return Object.assign(out, { reason: 'Its game.json is not valid JSON: ' + e.message }); }
  if (!g || typeof g !== 'object') return Object.assign(out, { reason: 'Its game.json is not an object.' });
  Object.assign(out, { name: g.name, version: g.version, players: g.players, needs: g.needs });
  const why = whyNot(root, folder, g);
  if (why) return Object.assign(out, why);
  return Object.assign(out, { ok: true, entry: g.entry });
}
function whyNot(root, folder, g) {
  if (typeof g.name !== 'string' || !g.name.trim()) return { reason: 'It has no name.' };
  if (g.api !== API) return { reason: 'It asks for API version ' + g.api + ', and this relay knows API version ' + API + '.' };
  if (typeof g.entry !== 'string' || !g.entry || path.isAbsolute(g.entry) || g.entry.split(/[\\/]/).includes('..')) return { reason: 'Its entry must be a file in its own folder.' };
  if (!fs.existsSync(path.join(root, folder, g.entry))) return { reason: 'Its entry file ' + g.entry + ' is missing.' };
  const p = g.players || {};
  if (!Number.isInteger(p.min) || !Number.isInteger(p.max) || p.min < 1 || p.max < p.min) return { reason: 'Its players need a whole min and max, with min at least 1 and max at least min.' };
  if (!Array.isArray(g.needs)) return { reason: 'Its needs must be a list.' };
  const unknown = g.needs.find((n) => !NEEDS.includes(n));
  if (unknown) return { reason: 'It needs ' + unknown + ', which is not a need games can ask for.', need: unknown };
  const cannot = g.needs.find((n) => !CAN.includes(n));
  if (cannot) return { reason: 'It needs ' + cannot + ', which this relay cannot do yet.', need: cannot };
  return null;
}

// What anyone may see of a round while it runs. No brief, no role and no truth are in it.
function view(r) {
  return { id: r.id, game: r.game, state: r.state, watch: r.watch, startedAt: r.startedAt, spentUsd: r.spent, capUsd: r.cap,
    seats: r.seats.map((s) => ({ seat: s.seat, terminal: s.terminal, waiting: onTrust(r.channel, s.terminal) ? 'trust' : null })) };
}

function startRound(channel, body, ctx) {
  if (rounds.has(channel)) return [409, { ok: false, error: 'round_running', message: 'A round is running. Finish or stop it first.' }];
  const game = listGames().find((g) => g.folder === body.game);
  if (!game) return [404, { ok: false, error: 'no_game', message: 'There is no game ' + body.game + ' in GAMES_REPO.' }];
  if (!game.ok) return [400, Object.assign({ ok: false, error: game.need ? 'needs' : 'bad_game', message: game.reason }, game.need ? { need: game.need } : {})];
  const n = Number(body.seats);
  if (!Number.isInteger(n) || n < game.players.min || n > game.players.max) return [400, { ok: false, error: 'bad_seats', message: game.name + ' takes ' + game.players.min + ' to ' + game.players.max + ' seats.' }];
  const watch = body.watch === undefined ? 'all' : body.watch;
  if (!WATCH.includes(watch)) return [400, { ok: false, error: 'bad_watch', message: 'Watch is all or none.' }];
  const cap = body.capUsd === undefined ? null : Number(body.capUsd);
  if (cap !== null && !(cap > 0)) return [400, { ok: false, error: 'bad_cap', message: 'The spend cap is a number of dollars above 0.' }];
  if (terminal.all(channel).length + n > terminal.DESKS) return [409, { ok: false, error: 'full', message: 'A round of ' + n + ' seats needs ' + n + ' free desks.' }];

  const dir = path.join(repo(), game.folder);
  const r = { id: crypto.randomBytes(4).toString('hex'), channel, game: game.folder, name: game.name, watch, cap, spent: 0, state: 'running',
    startedAt: new Date().toISOString(), seats: [], waiting: new Map(), ctx, ready: false, child: null };
  rounds.set(channel, r);
  // The game gets the relay's environment without its key and settings, as a session does.
  r.child = spawn(process.execPath, [path.join(dir, game.entry)], { cwd: dir, env: sessionEnv.build(process.env, {}), stdio: ['pipe', 'pipe', 'pipe'] });
  r.child.stderr.on('data', () => {});  // a game's own errors may hold its truth, so they are not logged
  r.child.on('error', (e) => endRound(r, 'failed', null, 'The game could not start: ' + e.message));
  // close, not exit: exit can come before the last lines the game wrote are read, such as its done.
  r.child.on('close', (code) => { if (r.state === 'running') endRound(r, 'failed', null, 'The game ended by itself (code ' + code + ').'); });
  r.child.stdin.on('error', () => {});
  readline.createInterface({ input: r.child.stdout }).on('line', (line) => fromGame(r, line));

  for (let i = 1; i <= n; i++) {
    const seat = 'S' + i;
    let s, got;
    try {
      const folder = path.join(seatsDir(), r.id, seat);
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      s = { seat, dir: fs.realpathSync(folder), terminal: null };
      got = terminal.start(channel, { cwd: s.dir, title: 'Seat ' + seat }, ctx, () => removeDir(s), { round: r.id });
    } catch (e) {
      if (s) removeDir(s);
      endRound(r, 'failed', null, 'Seat ' + seat + ' could not start: ' + e.message);
      return [500, { ok: false, error: 'seat_failed', message: 'Seat ' + seat + ' could not start: ' + e.message }];
    }
    if (got.status >= 300) { removeDir(s); endRound(r, 'failed', null, 'A seat could not start: ' + got.body.message); return [got.status, got.body]; }
    s.terminal = got.body.id;
    r.seats.push(s);
  }
  toGame(r, { type: 'hello', api: API });
  toGame(r, { type: 'setup', seed: String(body.seed || crypto.randomBytes(8).toString('hex')), settings: body.settings && typeof body.settings === 'object' ? body.settings : {}, seats: r.seats.map((s) => s.seat) });
  r.readyTimer = setTimeout(() => { if (!r.ready) endRound(r, 'failed', null, 'The game did not get ready in time.'); }, TIMEOUT());
  ctx.log('A round of ' + r.name + ' started with ' + n + ' seats, watch ' + watch + '.');
  return [200, { ok: true, round: view(r) }];
}

function toGame(r, m) {
  if (r.child && r.child.stdin.writable) r.child.stdin.write(JSON.stringify(m) + '\n');
}
function fromGame(r, line) {
  if (r.state !== 'running') return;
  let m;
  try { m = JSON.parse(line); } catch (e) { endRound(r, 'failed', null, 'The game sent a line that is not JSON.'); return; }
  if (!m || typeof m !== 'object') { endRound(r, 'failed', null, 'The game sent a line that is not an object.'); return; }
  if (m.type === 'hello') { if (m.api !== API) endRound(r, 'failed', null, 'The game speaks API version ' + m.api + '.'); return; }
  if (m.type === 'brief') { const s = r.seats.find((x) => x.seat === m.seat); if (s && typeof m.text === 'string') brief(r, s, m.text); return; }
  if (m.type === 'ready') { r.ready = true; clearTimeout(r.readyTimer); return; }
  if (m.type === 'answer') { const w = r.waiting.get(m.id); if (w) { r.waiting.delete(m.id); clearTimeout(w.timer); w.done(200, { ok: true, answer: m.text === undefined ? null : m.text }); } return; }
  if (m.type === 'spend') {
    r.spent += Number(m.usd) > 0 ? Number(m.usd) : 0;
    if (r.cap !== null && r.spent >= r.cap) endRound(r, 'stopped', null, 'The round reached its spend cap of $' + r.cap + '.');
    return;
  }
  if (m.type === 'done') { r.result = { score: m.score === undefined ? null : m.score, reveal: m.reveal === undefined ? null : m.reveal }; endRound(r, 'done', r.result.score); }
}

// Types a seat's brief as its first prompt, once the session can take it. The text lives only here.
function brief(r, s, text) {
  const since = Date.now();
  const tryNow = () => {
    if (r.state !== 'running') return;
    const t = terminal.find(r.channel, s.terminal);
    if (!t || t.exited) return;
    terminal.typeIfSafe(t, text, () => r.state === 'running', (problem) => {
      if (!problem || problem === 'ended') return;
      if (Date.now() - since > BRIEF_GIVE_UP) { r.ctx.log('Seat ' + s.seat + ' could not take its brief (' + problem + ').'); return; }
      setTimeout(tryNow, BRIEF_RETRY);
    });
  };
  tryNow();
}

function play(channel, agent, body) {
  const r = rounds.get(channel);
  const s = r && agent && r.seats.find((x) => x.terminal === agent.id);
  if (!s || r.state !== 'running') return Promise.resolve([403, { ok: false, error: 'forbidden', message: 'Only a seat in the round that runs can play.' }]);
  if (Object.prototype.hasOwnProperty.call(body, 'seat')) return Promise.resolve([400, { ok: false, error: 'bad_play', message: 'A seat plays only as itself, so a play names no seat.' }]);
  if (typeof body.kind !== 'string' || !/^[\w-]{1,32}$/.test(body.kind)) return Promise.resolve([400, { ok: false, error: 'bad_play', message: 'Send a kind, such as ask, and its args.' }]);
  const id = crypto.randomBytes(6).toString('hex');
  return new Promise((resolve) => {
    const timer = setTimeout(() => { r.waiting.delete(id); endRound(r, 'failed', null, 'The game did not answer a play in time.'); resolve([504, { ok: false, error: 'timeout', message: 'The game did not answer.' }]); }, TIMEOUT());
    r.waiting.set(id, { timer, done: (status, out) => resolve([status, out]) });
    toGame(r, { type: 'action', id, seat: s.seat, kind: body.kind, args: body.args && typeof body.args === 'object' ? body.args : {} });
  });
}

// A second finish while the first waits gets the same answer.
function finishRound(r) {
  if (r.finishing) return r.finishing;
  r.finishing = new Promise((resolve) => {
    const timer = setTimeout(() => { endRound(r, 'failed', null, 'The game did not finish in time.'); resolve([504, { ok: false, error: 'timeout', message: 'The game did not send its score in time.' }]); }, TIMEOUT());
    r.onDone = () => { clearTimeout(timer); resolve([200, { ok: true, round: Object.assign(view(r), r.result || { score: null, reveal: null }) }]); };
    toGame(r, { type: 'finish' });
  });
  return r.finishing;
}

// Ends a round: answers whatever waits, stops the game and every seat, and keeps only the id, game,
// time and score. why is said in the relay's log, and never holds the game's words.
function endRound(r, state, score, why) {
  if (r.state !== 'running') return;
  r.state = state;
  clearTimeout(r.readyTimer);
  if (rounds.get(r.channel) === r) rounds.delete(r.channel);
  for (const w of r.waiting.values()) { clearTimeout(w.timer); w.done(409, { ok: false, error: 'round_over', message: 'The round has ended.' }); }
  r.waiting.clear();
  if (state !== 'done') toGame(r, { type: 'abort' });
  const child = r.child;
  if (child) { try { child.stdin.end(); } catch (e) { /* gone */ } setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000).unref(); }
  for (const s of r.seats) {
    const t = terminal.find(r.channel, s.terminal);
    if (t && !t.exited) terminal.stop(t); else removeDir(s);
  }
  const list = past.get(r.channel) || [];
  list.unshift({ id: r.id, game: r.game, time: r.startedAt, score: state === 'done' ? score : null });
  past.set(r.channel, list.slice(0, KEEP_PAST));
  r.ctx.log('The round of ' + r.name + ' ' + (state === 'done' ? 'is done.' : 'ended: ' + (why || state) + '.'));
  if (r.onDone) r.onDone();
}
// A seat's folder goes when its session ends, and the round's folder with its last seat.
function removeDir(s) {
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch (e) { /* already gone */ }
  try { fs.rmdirSync(path.dirname(s.dir)); } catch (e) { /* another seat is still in it */ }
}

// For relay/server.js: whether a session is a seat in a round. Its token then reaches only /play. A
// seat stays one after its round ends, while it is still ending, since the session itself says so (its
// round). channel finds the session when only its id is known, as in a hook.
function isSeat(t, channel) {
  if (!t) return false;
  if (t.round) return true;
  const own = channel && t.id ? terminal.find(channel, t.id) : null;
  if (own && own.round) return true;
  for (const r of rounds.values()) if (r.seats.some((s) => s.terminal === t.id)) return true;
  return false;
}
// Whether a seat sits on Claude Code's question about trusting its folder. Nothing is typed into it
// until the person answers, so that answer is the one thing the person may type into a seat.
function onTrust(channel, id) {
  const t = terminal.find(channel, id);
  return !!(t && !t.exited && terminal.questionOnScreen(t) === 'trust');
}
// For relay/terminal.js: why the person may not open or type into a session now, or null.
terminal.guard((channel, t, verb) => {
  const r = rounds.get(channel);
  if (!r || !r.seats.some((s) => s.terminal === t.id)) return null;
  if (verb === 'input' && !onTrust(channel, t.id)) return 'A seat in a round is read-only, so watching never changes the play. Only the question about trusting its folder can be answered.';
  if (verb === 'stream' && r.watch === 'none') return 'This round is Watch none, so seat screens open when it ends.';
  return null;
});
// For relay/tickets.js and relay/autopilot.js: new starts wait while a round runs.
tickets.holdStarts((channel) => (rounds.has(channel) ? 'A round of ' + rounds.get(channel).name + ' is running. New tickets start when it ends.' : null));

const ROUTE = /^\/(games|play|rounds(\/current(\/(finish|stop))?)?)$/;
async function handle(req, res, channel, rest, ctx) {
  if (!ROUTE.test(rest)) return false;
  // Like every room route, these answer only the room page and the sessions on this computer.
  const deny = terminal.localOnly(req, ctx.port);
  if (deny) { ctx.problem(res, 403, 'local_only', deny); return true; }
  if (rest === '/games') {
    if (req.method !== 'GET') return false;
    ctx.send(res, 200, { ok: true, games: listGames().map((g) => { const o = Object.assign({}, g); delete o.need; delete o.entry; return o; }) });
    return true;
  }
  if (rest === '/play') {
    if (req.method !== 'POST') return false;
    const body = await ctx.readJson(req);
    const [status, out] = await play(channel, ctx.agent, body && typeof body === 'object' ? body : {});
    ctx.send(res, status, out); return true;
  }
  if (rest === '/rounds') {
    if (req.method === 'GET') { ctx.send(res, 200, { ok: true, rounds: past.get(channel) || [] }); return true; }
    if (req.method === 'POST') { const [status, out] = startRound(channel, (await ctx.readJson(req)) || {}, ctx); ctx.send(res, status, out); return true; }
    return false;
  }
  if (rest === '/rounds/current') {
    if (req.method !== 'GET') return false;
    const r = rounds.get(channel);
    ctx.send(res, 200, { ok: true, round: r ? view(r) : null }); return true;
  }
  const m = rest.match(/^\/rounds\/current\/(finish|stop)$/);
  if (m && req.method === 'POST') {
    const r = rounds.get(channel);
    if (!r) { ctx.problem(res, 409, 'no_round', 'No round is running.'); return true; }
    if (m[1] === 'stop') { endRound(r, 'stopped', null, 'the person stopped it'); ctx.send(res, 200, { ok: true, round: view(r) }); return true; }
    const [status, out] = await finishRound(r);
    ctx.send(res, status, out); return true;
  }
  return false;
}

module.exports = { handle, isSeat, listGames };
