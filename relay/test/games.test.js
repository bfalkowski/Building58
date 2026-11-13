// Games: the office can act out a game from another repo. The office does not change, only the roles
// of the sessions in it, for one round. These tests are the contract for the loader. They name no
// real game: each test writes a made-up game into a temporary GAMES_REPO, and its entry file loads
// relay/test/game.fixture.js.
//
// The contract, as these tests use it:
//   A game is a folder in GAMES_REPO with a game.json: { name, version, api, entry, players: { min,
//   max }, needs }. Version 1 of the loader can meet the needs privateBriefs, ask and files.
//   The relay runs each round's game as its own child process (node <entry>), and they talk in JSON
//   lines. The loader sends hello, setup { seed, settings, seats }, action { id, seat, kind, args },
//   finish and abort. The game sends hello, brief { seat, text }, ready, answer { id, text },
//   spend { usd } and done { score, reveal }.
//   Routes, on a channel, with the relay key:
//     GET  /games                    the games found, with ok and a reason for each
//     POST /rounds                   { game, seed, settings, seats, capUsd } starts a round
//     GET  /rounds/current           the round that runs, or null
//     POST /rounds/current/finish    asks the game for its score and reveal
//     POST /rounds/current/stop      ends the round with no score
//     GET  /rounds                   past rounds: id, game, time and score only
//   And with a seat's own session token (X-Office-Token), as relay/play.js sends it:
//     POST /play                     { kind, args } passes one action to the game for that seat
//
// The rules behind them are in the games repo's requirements: fresh sessions for seats, briefs as
// opaque text that the office never stores or shows, a seat that acts only as itself, the truth only
// after the reveal, and a game that fails ends its own round and nothing else.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { relay, until, sleep, sessionToken, makeRepo } = require('./helpers.js');
const { spawnSync } = require('child_process');
const { launch } = require('../session-host.js');

const REPO = path.join(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'game.fixture.js');
const seatHeaders = (token) => ({ 'X-Office-Token': token });

// A temporary GAMES_REPO with one folder per game. Each game's entry file loads the fake game.
function gamesRepo(t, games) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'games-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [folder, manifest] of Object.entries(games)) {
    fs.mkdirSync(path.join(root, folder));
    if (manifest === null) continue;  // a folder with no game.json
    const text = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
    fs.writeFileSync(path.join(root, folder, 'game.json'), text);
    fs.writeFileSync(path.join(root, folder, 'game.js'), 'require(' + JSON.stringify(FIXTURE) + ');\n');
  }
  return root;
}
const manifest = (extra) => Object.assign({ name: 'Coin toss', version: '0.1.0', api: 1, entry: 'game.js', players: { min: 2, max: 4 }, needs: ['privateBriefs', 'ask'] }, extra);

// A relay with one good game, and a round of two seats started on it.
async function roundOn(t, settings, body) {
  const root = gamesRepo(t, { coin: manifest() });
  const record = path.join(root, 'record.jsonl');
  const R = await relay({ GAMES_REPO: root, RELAY_GAME_TIMEOUT_MS: '2000' });
  t.after(R.stop);
  const before = (await R.call('GET', '/terminals')).body.terminals.map((x) => x.id);
  const started = await R.call('POST', '/rounds', Object.assign({ game: 'coin', seed: 'seed-1', settings: Object.assign({ record }, settings), seats: 2 }, body));
  const received = () => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { R, root, record, received, before, started };
}
const tokenOf = async (R, terminalId) => {
  const t = (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === terminalId);
  return until(() => { try { return sessionToken(t.sessionId); } catch (e) { return null; } }, 'the seat session');
};
// Every file under a folder, as text, so a test can search the relay's state for a marker.
const textUnder = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f))
  .filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, 'utf8')).join('\n') : '');

// Finding games

test('the relay lists the games in GAMES_REPO, and says why a folder is not one', async (t) => {
  const root = gamesRepo(t, {
    coin: manifest(),
    notes: null,
    broken: '{ not json',
    nameless: manifest({ name: undefined }),
    future: manifest({ api: 99 })
  });
  const R = await relay({ GAMES_REPO: root });
  t.after(R.stop);
  const r = await R.call('GET', '/games');
  assert.strictEqual(r.status, 200);
  const by = Object.fromEntries(r.body.games.map((g) => [g.folder, g]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['broken', 'coin', 'future', 'nameless'], 'a folder with no game.json is not listed');
  assert.deepStrictEqual({ ok: by.coin.ok, name: by.coin.name, players: by.coin.players, needs: by.coin.needs },
    { ok: true, name: 'Coin toss', players: { min: 2, max: 4 }, needs: ['privateBriefs', 'ask'] });
  for (const bad of ['broken', 'nameless', 'future']) {
    assert.strictEqual(by[bad].ok, false, bad + ' is not a game the loader can run');
    assert.match(by[bad].reason, /\S/, bad + ' says why');
  }
  assert.match(by.future.reason, /api/i, 'an unknown API version is named as the reason');
});

test('with no GAMES_REPO the relay lists no games', async (t) => {
  const R = await relay({ GAMES_REPO: '' });
  t.after(R.stop);
  assert.deepStrictEqual((await R.call('GET', '/games')).body.games, []);
});

test('a game that needs what the loader cannot do yet is listed as not ok, and a round of it is refused', async (t) => {
  const root = gamesRepo(t, { vote: manifest({ needs: ['privateBriefs', 'votes'] }) });
  const R = await relay({ GAMES_REPO: root });
  t.after(R.stop);
  const g = (await R.call('GET', '/games')).body.games[0];
  assert.strictEqual(g.ok, false);
  assert.match(g.reason, /votes/, 'the reason names the need');
  const r = await R.call('POST', '/rounds', { game: 'vote', seed: 's', seats: 2 });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.need, 'votes');
});

test('a round must have a seat count inside the game\'s players', async (t) => {
  const { R } = await roundOn(t, {}, { seats: 1 });
  const r = await R.call('POST', '/rounds', { game: 'coin', seed: 's', seats: 9 });
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await R.call('GET', '/rounds/current')).body.round, null, 'no round started for 1 or 9 seats');
});

test('no code in relay/, office/ or shared/ names a game from GAMES_REPO', (t) => {
  // Like relay/test/worlds-apart.test.js. Run with GAMES_REPO set to your games repo to check its names.
  const namesIn = (games, text) => games.filter((g) => new RegExp('\\b' + g + '\\b', 'i').test(text));
  assert.deepStrictEqual(namesIn(['coin'], 'The Coin game'), ['coin'], 'the match finds a game name in any case');
  const repo = process.env.GAMES_REPO;
  if (!repo || !fs.existsSync(repo)) return t.skip('GAMES_REPO is not set');
  const games = fs.readdirSync(repo).filter((d) => fs.existsSync(path.join(repo, d, 'game.json')));
  const filesIn = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' || d.name.startsWith('.') || p === __dirname ? [] : filesIn(p);
    return /\.(js|sh|py|html|css|md|json)$/.test(d.name) ? [p] : [];
  });
  const found = [];
  for (const top of ['relay', 'office', 'shared']) {
    for (const file of filesIn(path.join(REPO, top))) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const hit = namesIn(games, line);
        if (hit.length) found.push(path.relative(REPO, file) + ':' + (i + 1) + ' names ' + hit.join(', '));
      });
    }
  }
  assert.deepStrictEqual(found, [], 'Keep game code in the games repo, and describe the contract instead of a game.');
});

// Starting a round

test('a round runs the game in its own process and tells it the seed, the settings and the seats', async (t) => {
  const { R, started, received } = await roundOn(t, {});
  assert.strictEqual(started.status, 200);
  const round = started.body.round;
  assert.strictEqual(round.game, 'coin');
  assert.strictEqual(round.state, 'running');
  assert.deepStrictEqual(round.seats.map((s) => s.seat), ['S1', 'S2']);
  await until(() => received().some((m) => m.type === 'setup'), 'setup');
  const setup = received().find((m) => m.type === 'setup');
  assert.strictEqual(setup.seed, 'seed-1');
  assert.deepStrictEqual(setup.seats, ['S1', 'S2']);
  assert.strictEqual(received()[0].type, 'hello', 'hello comes first');
  assert.strictEqual((await R.call('POST', '/rounds', { game: 'coin', seed: 's', seats: 2 })).status, 409, 'one round at a time');
});

test('each seat is a fresh session in a new folder, and sees only its own brief', async (t) => {
  const { R, started, before } = await roundOn(t, {});
  const seats = started.body.round.seats;
  const terminals = (await R.call('GET', '/terminals')).body.terminals;
  for (const s of seats) {
    assert.ok(!before.includes(s.terminal), s.seat + ' is a new session, not one that was already working');
    const term = terminals.find((x) => x.id === s.terminal);
    assert.ok(term && term.running, s.seat + ' runs');
    assert.ok(!term.task, s.seat + ' has no task');
    assert.ok(fs.existsSync(term.cwd), s.seat + ' has its own folder');
    assert.ok(!fs.existsSync(path.join(term.cwd, '.git')), s.seat + '\'s folder is not a copy of a repo');
  }
  assert.notStrictEqual(terminals.find((x) => x.id === seats[0].terminal).cwd, terminals.find((x) => x.id === seats[1].terminal).cwd);
  await until(async () => (await R.screen(seats[0].terminal)).includes('BRIEF-MARK-S1'), 'S1 to get its brief');
  await until(async () => (await R.screen(seats[1].terminal)).includes('BRIEF-MARK-S2'), 'S2 to get its brief');
  assert.ok(!(await R.screen(seats[0].terminal)).includes('BRIEF-MARK-S2'), 'S1 never sees the brief of S2');
  assert.ok(!(await R.screen(seats[1].terminal)).includes('BRIEF-MARK-S1'), 'S2 never sees the brief of S1');
});

test('the office never stores, logs or shows a brief, and has no field for a role', async (t) => {
  const { R, started } = await roundOn(t, {});
  const seats = started.body.round.seats;
  await until(async () => (await R.screen(seats[1].terminal)).includes('BRIEF-MARK-S2'), 'the briefs');
  const routes = await Promise.all(['/rounds/current', '/rounds', '/terminals', '/tickets', '/tasks', '/games']
    .map(async (p) => JSON.stringify((await R.call('GET', p)).body)));
  for (const text of routes) assert.ok(!/BRIEF-MARK/.test(text), 'no route shows a brief: ' + text.slice(0, 200));
  assert.ok(!/BRIEF-MARK/.test(R.output()), 'the relay never logs a brief');
  // The seat folders are the seats' own. Everything else the relay keeps is searched.
  const seatDirs = (await R.call('GET', '/terminals')).body.terminals.filter((x) => seats.some((s) => s.terminal === x.id)).map((x) => x.cwd);
  const kept = fs.readdirSync(R.home, { recursive: true }).map((f) => path.join(R.home, f))
    .filter((f) => !seatDirs.some((d) => f.startsWith(d)) && fs.statSync(f).isFile() && fs.statSync(f).size < 5e6);
  const hits = kept.filter((f) => /BRIEF-MARK/.test(fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(hits.map((f) => path.relative(R.home, f)), [], 'no file the relay keeps holds a brief');
  const round = (await R.call('GET', '/rounds/current')).body.round;
  assert.ok(!/role/i.test(JSON.stringify(round)), 'a round has no field for a role');
});

// Playing

test('a seat acts only as itself: play needs a seat token, and the body cannot name a seat', async (t) => {
  const { R, started, received } = await roundOn(t, {});
  const [s1, s2] = started.body.round.seats;
  const t1 = await tokenOf(R, s1.terminal);
  const ok = await R.call('POST', '/play', { kind: 'ask', args: { text: 'Is this allowed?' } }, seatHeaders(t1));
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.answer, 'The assistant answers S1 about ask', 'the game\'s answer comes back to the seat');
  const sent = received().filter((m) => m.type === 'action');
  assert.deepStrictEqual(sent.map((m) => [m.seat, m.kind, m.args.text]), [['S1', 'ask', 'Is this allowed?']]);
  const asOther = await R.call('POST', '/play', { seat: s2.seat, kind: 'ask', args: {} }, seatHeaders(t1));
  assert.strictEqual(asOther.status, 400, 'a body that names a seat is refused');
  assert.strictEqual((await R.call('POST', '/play', { kind: 'ask', args: {} }, seatHeaders('not-a-token'))).status, 403);
  const other = (await R.call('POST', '/terminals', { cwd: os.tmpdir() })).body;
  const outsider = await tokenOf(R, other.id || other.terminal.id);
  assert.strictEqual((await R.call('POST', '/play', { kind: 'ask', args: {} }, seatHeaders(outsider))).status, 403, 'a session outside the round cannot play');
});

test('a seat gets no real work: the ticket routes refuse its token', async (t) => {
  const { R, started } = await roundOn(t, {});
  const token = await tokenOf(R, started.body.round.seats[0].terminal);
  assert.strictEqual((await R.call('POST', '/tickets', { title: 'From a seat' }, seatHeaders(token))).status, 403);
  assert.strictEqual((await R.call('GET', '/tickets', null, seatHeaders(token))).status, 403);
});

test('relay/play.js sends an action with the session\'s own token', async (t) => {
  const { R, started } = await roundOn(t, {});
  const token = await tokenOf(R, started.body.round.seats[0].terminal);
  const { execFileSync } = require('child_process');
  const out = execFileSync('node', [path.join(REPO, 'relay', 'play.js'), 'ask', 'Is "keeps colds away" a claim?'], {
    env: { ...process.env, OFFICE_TICKET_TOKEN: token, OFFICE_TICKET_URL: R.base }, encoding: 'utf8'
  });
  assert.match(out, /The assistant answers S1 about ask/);
});

// Ending a round

test('finish shows the score and the reveal, ends every seat, and removes the seat folders', async (t) => {
  const { R, started } = await roundOn(t, {});
  const seats = started.body.round.seats;
  const before = (await R.call('GET', '/rounds/current')).body.round;
  assert.ok(!('reveal' in before) && !/TRUTH-MARK/.test(JSON.stringify(before)), 'no truth before the reveal');
  const dirs = (await R.call('GET', '/terminals')).body.terminals.filter((x) => seats.some((s) => s.terminal === x.id)).map((x) => x.cwd);
  const r = await R.call('POST', '/rounds/current/finish', {});
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.round.state, 'done');
  assert.deepStrictEqual(r.body.round.score.metrics, { caught: 1, falseAccusations: 0 });
  assert.strictEqual(r.body.round.reveal.note, 'TRUTH-MARK');
  await until(async () => !(await R.call('GET', '/terminals')).body.terminals.some((x) => seats.some((s) => s.terminal === x.id)), 'the seats to end');
  for (const d of dirs) assert.ok(!fs.existsSync(d), 'the seat folder is removed: ' + d);
  const past = (await R.call('GET', '/rounds')).body.rounds;
  assert.strictEqual(past.length, 1);
  assert.deepStrictEqual(Object.keys(past[0]).sort(), ['game', 'id', 'score', 'time'], 'the office keeps only the id, the game, the time and the score');
  assert.ok(!/TRUTH-MARK|BRIEF-MARK/.test(textUnder(R.home)), 'and keeps no truth and no brief');
});

test('stop sends abort, ends every seat, and keeps no score', async (t) => {
  const { R, started, received } = await roundOn(t, {});
  const seats = started.body.round.seats;
  const r = await R.call('POST', '/rounds/current/stop', {});
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.round.state, 'stopped');
  await until(() => received().some((m) => m.type === 'abort'), 'the game to get abort');
  await until(async () => !(await R.call('GET', '/terminals')).body.terminals.some((x) => seats.some((s) => s.terminal === x.id)), 'the seats to end');
  assert.strictEqual((await R.call('GET', '/rounds/current')).body.round, null);
});

for (const [mode, what] of [['crash', 'exits'], ['badline', 'sends a line that is not JSON'], ['hang', 'stops answering']]) {
  test('a game that ' + what + ' ends its own round, and the relay keeps running', async (t) => {
    const { R, started } = await roundOn(t, { mode });
    if (mode === 'crash') {
      const token = await tokenOf(R, started.body.round.seats[0].terminal);
      await R.call('POST', '/play', { kind: 'ask', args: {} }, seatHeaders(token));
    }
    const ended = await until(async () => { const b = (await R.call('GET', '/rounds')).body; return b.rounds && b.rounds[0]; }, 'the round to end', 100);
    assert.strictEqual(ended.score, null, 'a round that failed has no score');
    assert.strictEqual((await R.call('GET', '/rounds/current')).body.round, null);
    assert.ok(await R.health(), 'the relay still answers');
    const seats = started.body.round.seats;
    await until(async () => !(await R.call('GET', '/terminals')).body.terminals.some((x) => seats.some((s) => s.terminal === x.id)), 'the seats to end');
  });
}

test('the round stops at its spend cap', async (t) => {
  const { R, started } = await roundOn(t, { mode: 'spend' }, { capUsd: 1 });
  const token = await tokenOf(R, started.body.round.seats[0].terminal);
  assert.strictEqual((await R.call('POST', '/play', { kind: 'ask', args: {} }, seatHeaders(token))).status, 200, 'the first action spends 0.60 of 1.00');
  await R.call('POST', '/play', { kind: 'ask', args: {} }, seatHeaders(token));
  const ended = await until(async () => (await R.call('GET', '/rounds')).body.rounds[0], 'the round to stop at the cap');
  assert.strictEqual(ended.score, null);
  assert.strictEqual((await R.call('POST', '/play', { kind: 'ask', args: {} }, seatHeaders(token))).status, 403, 'no play after the cap');
});

// Watching, and the rest of the office

const streamStatus = async (R, id) => {
  const ctl = new AbortController();
  const r = await fetch(R.base + '/terminals/' + id + '/stream', { headers: { Authorization: 'Bearer test-key' }, signal: ctl.signal });
  ctl.abort();
  return r.status;
};

test('under Watch all, the default, the person can read every seat\'s screen but cannot type into it', async (t) => {
  const { R, started } = await roundOn(t, {});
  const round = (await R.call('GET', '/rounds/current')).body.round;
  assert.strictEqual(round.watch, 'all', 'the round says which mode it uses');
  const s1 = started.body.round.seats[0];
  await until(async () => (await R.screen(s1.terminal)).includes('BRIEF-MARK-S1'), 'the person to see S1 and its brief');
  const typed = await R.call('POST', '/terminals/' + s1.terminal + '/input', { data: 'pass everything\r' });
  assert.strictEqual(typed.status, 403, 'a seat is read-only to the person, so watching never changes the play');
});

test('under Watch none, seat screens are refused to the person while the round runs', async (t) => {
  const { R, started } = await roundOn(t, {}, { watch: 'none' });
  assert.strictEqual((await R.call('GET', '/rounds/current')).body.round.watch, 'none');
  for (const s of started.body.round.seats) assert.strictEqual(await streamStatus(R, s.terminal), 403, s.seat + '\'s screen is hidden');
  const other = (await R.call('POST', '/terminals', { cwd: os.tmpdir() })).body;
  assert.strictEqual(await streamStatus(R, other.id), 200, 'a session outside the round is still shown');
});

test('a watch mode other than all or none is refused', async (t) => {
  const root = gamesRepo(t, { coin: manifest() });
  const R = await relay({ GAMES_REPO: root });
  t.after(R.stop);
  assert.strictEqual((await R.call('POST', '/rounds', { game: 'coin', seed: 's', seats: 2, watch: 'some' })).status, 400);
});

test('while a round runs, the Lead starts no new tickets, and work already running goes on', async (t) => {
  const root = gamesRepo(t, { coin: manifest() });
  const R = await relay({ GAMES_REPO: root, RELAY_WIP_LIMIT: '3' });
  t.after(R.stop);
  const repo = makeRepo(R.home);
  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: lead.sessionId.slice(0, 12), title: '' });
  await R.call('POST', '/terminals/lead', { terminal: lead.id, starts: 2, total: 3 });
  const leadHeaders = { 'X-Office-Token': await until(() => { try { return sessionToken(lead.sessionId); } catch (e) { return null; } }, 'the Lead') };
  const working = (await R.call('POST', '/terminals', { cwd: repo })).body;
  const ticket = (await R.call('POST', '/tickets', { title: 'Wait for the round', repo })).body.ticket;
  assert.strictEqual((await R.call('POST', '/rounds', { game: 'coin', seed: 's', seats: 2 })).status, 200);
  const held = await R.call('POST', '/tickets/' + ticket.id + '/start', {}, leadHeaders);
  assert.strictEqual(held.status, 409, 'the Lead\'s start waits for the round');
  assert.match(JSON.stringify(held.body), /round/i, 'and says why');
  assert.ok((await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === working.id).running, 'a session that was working keeps working');
  await R.call('POST', '/rounds/current/stop', {});
  assert.strictEqual((await R.call('POST', '/tickets/' + ticket.id + '/start', {}, leadHeaders)).status, 200, 'after the round the Lead can start it');
});

test('while a round runs, Autopilot starts no new tickets, and says why', async (t) => {
  const root = gamesRepo(t, { coin: manifest() });
  const R = await relay({ GAMES_REPO: root, RELAY_AUTOPILOT_TICK_MS: '300' });
  t.after(R.stop);
  const repo = makeRepo(R.home);
  const ticket = (await R.call('POST', '/tickets', { title: 'Wait for the round', repo })).body.ticket;
  assert.strictEqual((await R.call('POST', '/rounds', { game: 'coin', seed: 's', seats: 2 })).status, 200);
  assert.strictEqual((await R.call('POST', '/autopilot', { on: true, only: ticket.id })).status, 200);
  await sleep(1500);
  assert.strictEqual((await R.call('GET', '/tasks')).body.tasks.length, 0, 'nothing starts during the round');
  assert.match(String((await R.call('GET', '/autopilot')).body.idle), /round/i, 'Autopilot says it waits for the round');
  await R.call('POST', '/rounds/current/stop', {});
  await until(async () => (await R.call('GET', '/tasks')).body.tasks.length === 1, 'the start once the round ends', 100);
  await R.call('POST', '/autopilot', { on: false });
});

// Folder trust, restarts and queued hooks

test('a seat on the trust question shows waiting, takes the person\'s answer, then its brief, and is read-only after', async (t) => {
  const root = gamesRepo(t, { coin: manifest() });
  const R = await relay({ GAMES_REPO: root, FAKE_CLAUDE_TRUST: '1' });
  t.after(R.stop);
  const round = (await R.call('POST', '/rounds', { game: 'coin', seed: 's', seats: 2 })).body.round;
  const s1 = round.seats[0];
  const term = (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === s1.terminal);
  const stateDir = path.join(R.home, '.office-world');
  assert.ok(term.cwd.startsWith(path.join(fs.realpathSync(stateDir), 'seats', round.id) + path.sep), 'seat folders sit under one parent in the state folder: ' + term.cwd);
  const seatOf = async () => (await R.call('GET', '/rounds/current')).body.round.seats.find((x) => x.seat === 'S1');
  await until(async () => (await seatOf()).waiting === 'trust', 'the round to show S1 waits on the trust question');
  await sleep(2000);
  assert.ok(!(await R.screen(s1.terminal)).includes('BRIEF-MARK-S1'), 'no brief while the question is up');
  const answer = await R.call('POST', '/terminals/' + s1.terminal + '/input', { data: 'yes'.repeat(150) + '\r' });
  assert.strictEqual(answer.status, 200, 'the person may answer the trust question');
  await R.hook({ hook_event_name: 'SessionStart', session_id: term.sessionId.slice(0, 12) });
  await until(async () => (await R.screen(s1.terminal)).includes('BRIEF-MARK-S1'), 'the brief once the question is answered', 150);
  assert.strictEqual((await seatOf()).waiting, null);
  assert.strictEqual((await R.call('POST', '/terminals/' + s1.terminal + '/input', { data: 'pass everything\r' })).status, 403, 'after the question, the seat is read-only again');
  await R.call('POST', '/rounds/current/finish', {});
  await until(() => !fs.existsSync(path.join(stateDir, 'seats', round.id)), 'the round\'s seat folder to go');
});

test('a relay that restarts mid-round brings back no seat, removes the seat folders, and has no round', async (t) => {
  const host = launch();
  t.after(() => new Promise((r) => host.stop(r)));
  assert.strictEqual(await host.ready, true);
  const root = gamesRepo(t, { coin: manifest() });
  const env = { GAMES_REPO: root, RELAY_WORKER: '1', RELAY_HOST_SOCKET: host.socket, RELAY_RESUME: '1' };
  let R = await relay(env);
  const home = R.home, port = R.port;
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const other = (await R.call('POST', '/terminals', { cwd: home })).body;
  const round = (await R.call('POST', '/rounds', { game: 'coin', seed: 's', seats: 2 })).body.round;
  const terms = (await R.call('GET', '/terminals')).body.terminals;
  const seats = terms.filter((x) => round.seats.some((s) => s.terminal === x.id));
  await until(async () => (await R.screen(seats[1].id)).includes('BRIEF-MARK-S2'), 'the briefs');
  await R.kill();
  R = await relay(env, home, { port });
  await until(async () => (await R.call('GET', '/terminals')).body.terminals.some((x) => x.id === other.id), 'the other session back');
  await sleep(500);
  const after = (await R.call('GET', '/terminals')).body.terminals;
  assert.deepStrictEqual(after.filter((x) => seats.some((s) => s.sessionId === x.sessionId)).map((x) => x.id), [], 'no seat comes back');
  for (const s of seats) await until(() => !fs.existsSync(s.cwd), 'the seat folder to go: ' + s.cwd);
  assert.strictEqual((await R.call('GET', '/rounds/current')).body.round, null);
  assert.ok(!/BRIEF-MARK/.test(R.output()), 'the log holds no brief');
});

test('a seat\'s hook keeps none of its words, sent or queued while the relay is away', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seat-hook-')));
  fs.mkdirSync(path.join(home, '.office-world'));  // the queue is kept only where a room has run
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OFFICE_|RELAY_)/.test(k)));
    Object.assign(env, { HOME: home, OFFICE_SEAT: '1', OFFICE_SHOW_PROMPTS: '1', OFFICE_TICKET_TOKEN: 'seat-token', OFFICE_TERMINAL_ID: 'abcdefabcdef', OFFICE_HOOK_URL: 'http://127.0.0.1:9/channels/t/commands' });
    const event = { hook_event_name: 'UserPromptSubmit', session_id: 'b299ee24-0c4c-4507-afb7-bb2625eeb192', prompt: 'Your brief, S1. BRIEF-MARK-S1', message: 'BRIEF-MARK-S1 again', cwd: home };
    const r = spawnSync('node', [path.join(REPO, 'relay', 'office-hook.js')], { input: JSON.stringify(event), env, encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(r.status, 0);
    const queued = fs.readFileSync(path.join(home, '.office-world', 'hook-queue.jsonl'), 'utf8');
    const e = JSON.parse(queued.trim().split('\n')[0]).event;
    assert.strictEqual(e.hook_event_name, 'UserPromptSubmit', 'the event still goes');
    assert.ok(!/BRIEF-MARK/.test(queued), 'but none of the seat\'s words: ' + queued);
    for (const k of ['prompt', 'title', 'customTitle', 'message']) assert.ok(!(k in e), 'no ' + k);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// Not testable yet

test.todo('the spend cap counts each seat session\'s own cost, from what its status line reports');
test.todo('a seat with a shell, asked to find out who is paid, cannot read the games repo, the sealed folder, the seed or another seat\'s transcript (needs seats separated by the operating system)');
