#!/usr/bin/env node
// The relay. Passes commands from outside callers (curl, a script,
// an agent) to a page running the world, and passes results and events back.
// Node 18 or later, no dependencies. See docs/manual/relay.html.
'use strict';

if (process.env.RELAY_WORKER !== '1') { require('./supervisor.js').supervise(__filename); return; }

const KEY_GIVEN = process.env.RELAY_KEY_RANDOM === '1' ? '' : process.env.RELAY_KEY || '';
const KEY_SET = process.env.RELAY_KEY || '';
delete process.env.RELAY_KEY; delete process.env.RELAY_KEY_RANDOM;

const http = require('http');
const fs = require('fs');
const api = require('./api-schemas.js');
const { tokenReaches } = require('./token-routes.js');
const openapi = require('./openapi.js');
const path = require('path');
const crypto = require('crypto');
const cfAccess = require('./cf-access.js');

const ROOT = path.resolve(process.env.RELAY_ROOT || path.join(__dirname, '..'));

function worldIn(dir) {
  let w;
  try { w = JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'world.json'), 'utf8')); } catch { return null; }
  if (!w || typeof w.name !== 'string' || typeof w.channel !== 'string') return null;
  const roster = typeof w.roster === 'string' && /^[\w-]+\.js$/.test(w.roster) ? w.roster : null;
  return { dir, name: w.name, channel: w.channel, port: Number(w.port) || null, sessions: w.sessions === true, roster };
}
function worlds() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
    .map((d) => worldIn(d.name)).filter(Boolean).sort((a, b) => a.dir.localeCompare(b.dir));
}
const WORLD = (process.env.RELAY_WORLD || '').replace(/\/+$/, '');
if ((process.env.RELAY_WORLD && !WORLD) || (WORLD && !/^[\w-]+$/.test(WORLD))) { console.error('RELAY_WORLD is ' + process.env.RELAY_WORLD + ', but it must be one folder name, such as the folder of a world in ' + ROOT + '.'); process.exit(1); }
const ONE = WORLD ? worldIn(WORLD) : null;
if (WORLD && !ONE) { console.error('RELAY_WORLD is ' + WORLD + ', but ' + path.join(ROOT, WORLD, 'world.json') + ' is missing or has no name and channel.'); process.exit(1); }

const SESSIONS = !ONE || ONE.sessions;
const office = SESSIONS ? {
  terminal: require('./terminal.js'), tasks: require('./tasks.js'), checkouts: require('./checkouts.js'), tickets: require('./tickets.js'),
  huddles: require('./huddles.js'), chat: require('./chat.js'), floor: require('./floor.js'), prComments: require('./pr-comments.js'),
  update: require('./update.js'), sessions: require('./sessions.js'), reviews: require('./reviews.js'), autopilot: require('./autopilot.js'),
  config: require('./config.js'), rules: require('./rules.js'), coo: require('./coo.js'), metrics: require('./metrics.js'), jams: require('./jams.js'), failures: require('./failures.js'), flake: require('./flake.js'), leadStuck: require('./lead-stuck.js'), leadCommands: require('./lead-commands.js'), security: require('./security.js'), boardPush: require('./board-push.js'), leadCheck: require('./lead-check.js'), pmSort: require('./pm-sort.js'),
  mainMoves: require('./main-moves.js'), prWatch: require('./pr-watch.js'), managerWatch: require('./manager-watch.js'), games: require('./games.js'), needsYou: require('./needs-you.js'), ready: require('./ready.js'), oldRelays: require('./old-relays.js'), awake: require('./awake.js')
} : null;
if (office) {
  const w = (ONE ? [ONE] : worlds()).find((x) => x.sessions && x.roster);
  if (w) {
    try { office.terminal.setRoster(require(path.join(ROOT, w.dir, w.roster))); } catch (e) { console.error('Could not read the roster ' + path.join(w.dir, w.roster) + ', so sessions have no names: ' + e.message); }
  }
}
const LEAD_CHANNEL = office ? ((ONE ? [ONE] : worlds()).find((x) => x.sessions) || {}).channel || null : null;
const ROUTES = office ? ['terminal', 'tasks', 'checkouts', 'reviews', 'autopilot', 'config', 'rules', 'tickets', 'huddles', 'chat', 'floor', 'update', 'coo', 'metrics', 'jams', 'failures', 'leadStuck', 'leadCommands', 'security', 'prWatch', 'managerWatch', 'games', 'needsYou', 'ready', 'oldRelays'].map((k) => office[k]) : [];

const PORT = Number(process.env.PORT || (ONE && ONE.port) || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const KEY = KEY_SET || crypto.randomBytes(12).toString('hex');
let REMOTE = null;
try { const cfg = cfAccess.fromEnv(process.env); REMOTE = cfg && cfAccess.gate(cfg); } catch (e) { console.error(e.message); process.exit(1); }
const WEBHOOK_URL = process.env.RELAY_WEBHOOK_URL || '';
const WEBHOOK_AUTH = process.env.RELAY_WEBHOOK_AUTH || '';
const WEBHOOK_TYPES = (process.env.RELAY_WEBHOOK_TYPES || 'result,run.started,run.live,run.off,thing.added,dale.said,dale.moved,phone.rang')
  .split(',').map((s) => s.trim()).filter(Boolean);
const MAX_EVENTS = 2000, MAX_RESULTS = 500, MAX_BODY = 256 * 1024;

const channels = new Map();
function channel(name) {
  if (!channels.has(name)) {
    channels.set(name, { name, pages: [], pending: new Map(), results: new Map(), events: [], rseq: 0, lastSeen: null });
  }
  return channels.get(name);
}
const CHANNEL_RE = /^[A-Za-z0-9_-]{1,64}$/;

function send(res, status, body, headers) {
  const data = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, Object.assign({
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, cors(), headers || {}));
  res.end(data);
}
function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Private-Network': 'true'
  };
}
function problem(res, status, error, message, extra) { send(res, status, Object.assign({ ok: false, error, message }, extra || {})); }
const COOKIE = 'relay_key_' + PORT;
function cookieKey(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; } }
  }
  return '';
}
function givenKey(req, url) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : (url.searchParams.get('key') || cookieKey(req));
}
function sameKey(given) {
  const a = Buffer.from(given), b = Buffer.from(KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function authorized(req, url) { return sameKey(givenKey(req, url)); }
function cookieOnly(req, url) { return !(req.headers.authorization || '').startsWith('Bearer ') && !url.searchParams.get('key') && !!cookieKey(req); }
function foreignOrigin(req, url) {
  if (!cookieOnly(req, url) || !authorized(req, url)) return false;
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== req.headers.host; } catch { return true; }
}
function keyToCookie(req, res, url) {
  const given = url.searchParams.get('key');
  if (!given || !sameKey(given)) return false;
  url.searchParams.delete('key');
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.writeHead(302, { Location: url.pathname + url.search, 'Set-Cookie': COOKIE + '=' + encodeURIComponent(given) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000' + secure, 'Cache-Control': 'no-store' });
  res.end();
  return true;
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('The body is too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) { resolve({}); return; }
      try { resolve(JSON.parse(text)); } catch (e) { reject(Object.assign(new Error('The body is not valid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { send(res, 404, 'Not found'); return; }
  if (rel.endsWith('/')) rel += 'index.html';
  if (rel.endsWith('.html') && keyToCookie(req, res, url)) return;
  const file = path.resolve(ROOT, '.' + rel);
  const parts = rel.split('/');
  const refused = (p) => p.startsWith('.') || /[^\x20-\x7e]/.test(p) || ['node_modules', 'relay'].includes(p.toLowerCase());
  if (!file.startsWith(ROOT + path.sep) || parts.some(refused)) {
    send(res, 404, 'Not found'); return;
  }
  if (ONE) {
    if (rel === '/index.html') { res.writeHead(302, { Location: '/' + ONE.dir + '/' + url.search + url.hash }); res.end(); return; }
    if (parts.length > 2 && ![ONE.dir, 'shared', 'docs'].includes(parts[1])) { send(res, 404, 'Not found'); return; }
    if (parts.length === 2 && ![ONE.dir, 'shared', 'docs'].includes(parts[1]) && fs.existsSync(file) && fs.statSync(file).isDirectory()) { send(res, 404, 'Not found'); return; }
  }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) {
      res.writeHead(301, { Location: url.pathname + '/' + url.search }); res.end(); return;
    }
    if (err || !st.isFile()) { send(res, 404, 'Not found'); return; }
    const head = { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    const old = rel.endsWith('.html') ? cookieKey(req) : '';
    if (old && !sameKey(old)) head['Set-Cookie'] = COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
    if (rel === '/docs/openapi.json') {
      fs.readFile(file, 'utf8', (e, text) => {
        let body = null;
        try { if (!e) body = openapi.served(text); } catch (_) { body = null; }
        if (body === null) { send(res, 500, 'The API document could not be read'); return; }
        res.writeHead(200, head);
        res.end(body);
      });
      return;
    }
    res.writeHead(200, head);
    fs.createReadStream(file).pipe(res);
  });
}

let pageSeq = 0;
const throughTunnel = (req) => cfAccess.CF_HEADERS.some((h) => req.headers[h] !== undefined) || !!(REMOTE && REMOTE.applies(req));
const visibleCount = (ch) => ch.pages.filter((p) => p.visible).length;
function openStream(req, res, ch, url) {
  res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }, cors()));
  res.write('retry: 2000\n\n');
  const page = { id: ++pageSeq, res, since: new Date().toISOString(), visible: true, tunnel: throughTunnel(req) };
  ch.pages.push(page); ch.lastSeen = page.since;
  const board = !!office && url.searchParams.get('board') === '1' && office.boardPush.sends(req, PORT);
  res.write('event: hello\ndata: ' + JSON.stringify({ channel: ch.name, page: page.id, tickets: board }) + '\n\n');
  if (board) office.boardPush.watch(req, res, ch.name, log);
  log('page connected to', ch.name, (page.tunnel ? 'through a tunnel ' : '') + '(' + ch.pages.length + ' open)');
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    ch.pages = ch.pages.filter((p) => p !== page);
    log('page left', ch.name, '(' + ch.pages.length + ' open)');
  });
}
function finish(ch, id, result) {
  const entry = ch.results.get(id);
  if (!entry || entry.status === 'done') return;
  entry.status = 'done'; entry.result = result; entry.doneAt = new Date().toISOString();
  const waiter = ch.pending.get(id);
  if (waiter) { ch.pending.delete(id); waiter(entry); }
}
function addEvents(ch, list) {
  const added = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const ev = Object.assign({ rseq: ++ch.rseq, receivedAt: new Date().toISOString() }, e);
    ch.events.push(ev); added.push(ev);
  }
  if (ch.events.length > MAX_EVENTS) ch.events.splice(0, ch.events.length - MAX_EVENTS);
  ch.lastSeen = new Date().toISOString();
  if (WEBHOOK_URL) {
    const out = added.filter((e) => WEBHOOK_TYPES.includes(e.type));
    if (out.length) {
      const headers = { 'Content-Type': 'application/json' };
      if (WEBHOOK_AUTH) headers.Authorization = WEBHOOK_AUTH;
      fetch(WEBHOOK_URL, { method: 'POST', headers, body: JSON.stringify({ channel: ch.name, events: out }) })
        .catch((err) => log('webhook failed:', err.message));
    }
  }
}

function pickPage(ch) {
  const local = ch.pages.filter((p) => !p.tunnel);
  const pool = local.length ? local : ch.pages;
  const shown = pool.filter((p) => p.visible);
  return shown.length ? shown[shown.length - 1] : pool[pool.length - 1];
}
function sendCommand(ch, command) {
  const page = pickPage(ch);
  if (!page) return null;
  const id = crypto.randomUUID();
  ch.results.set(id, { id, status: 'pending', command, sentAt: new Date().toISOString(), page });
  if (ch.results.size > MAX_RESULTS) ch.results.delete(ch.results.keys().next().value);
  page.res.write('event: command\ndata: ' + JSON.stringify({ id, command }) + '\n\n');
  return id;
}
function reply(entry, ch) {
  const r = entry.result || {};
  return Object.assign({ id: entry.id, channel: ch.name, action: entry.command.action }, r);
}

const nothingHere = (req, res) => { if (req.method === 'GET') send(res, 404, 'Not found'); else problem(res, 404, 'not_found', 'There is nothing here.'); };
async function handle(req, res) {
  if (req.url.startsWith('//')) { nothingHere(req, res); return; }
  if (REMOTE && REMOTE.applies(req) && !await REMOTE.allows(req)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('Forbidden'); return; }
  const url = new URL(req.url, 'http://relay');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors()); res.end(); return; }

  if (url.pathname === '/health') {
    const restore = office && authorized(req, url) && !office.terminal.localOnly(req, PORT) ? { restore: office.sessions.restored } : {};
    send(res, 200, Object.assign({ ok: true, world: ONE ? ONE.dir : null, channels: [...channels.values()].map((c) => ({ channel: c.name, pages: c.pages.length, pagesVisible: visibleCount(c) })) }, restore));
    return;
  }
  if (foreignOrigin(req, url)) { problem(res, 403, 'forbidden', 'The cookie works only for the room page on this relay\'s own address. From a script, send the key as "Authorization: Bearer <key>".'); return; }
  const m = url.pathname.match(/^\/channels\/([^/]+)(\/[^?]*)?$/);
  if (!m) { if (req.method === 'GET') serveStatic(req, res, url); else nothingHere(req, res); return; }
  if (office && !hooksOpen && req.method === 'POST' && m[2] === '/commands') {
    const body = await readJson(req).catch(() => null);
    if (body && body.action === 'hook' && body.event && typeof body.event === 'object' && !office.terminal.localOnly(req, PORT)) {
      const h = String(req.headers.authorization || ''), secret = req.headers['x-office-token'] || (h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('key') || '');
      earlyHooks.push({ to: 'http://127.0.0.1:' + PORT + '/channels/' + m[1] + '/commands', auth: hookQueue.hash(secret), event: Object.assign({ at: Date.now() }, body.event) });
      send(res, 202, { ok: true, status: 'queued' });
    } else problem(res, 503, 'starting', 'The relay is starting. Try again in a moment.');
    return;
  }

  const agent = authorized(req, url) || !office ? null : office.terminal.agentFor(req);
  const seat = !!(agent && office.games.isSeat(agent));
  const plays = req.method === 'POST' && m[2] === '/play';
  const tokenMay = agent && agent.channel === m[1] && tokenReaches(agent, req.method, m[2] || '', seat);
  if (!authorized(req, url) && !tokenMay && (seat || (office && plays))) { problem(res, 403, 'forbidden', seat ? 'A seat in a round only plays, with node "$OFFICE_PLAY".' : 'Only a seat in the round that runs can play.'); return; }
  if (!authorized(req, url) && !tokenMay && agent && agent.channel === m[1] && /^\/tickets\/[\w-]{1,64}\/order$/.test(m[2] || '')) { problem(res, 403, 'forbidden', 'Only the person sets a ticket\'s priority and place in the work order, and a PM or Lead they let set it.'); return; }
  if (!authorized(req, url) && !tokenMay && agent && agent.channel === m[1] && m[2] === '/settings') { problem(res, 403, 'person_only', 'Only the person changes the settings, PM trust included.'); return; }
  if (!authorized(req, url) && !tokenMay && agent && agent.channel === m[1] && /^\/tickets\/[\w-]{1,64}\/advice$/.test(m[2] || '')) { problem(res, 403, 'forbidden', 'Only the PM answers the check of a ticket.'); return; }
  if (!authorized(req, url) && !tokenMay && agent && agent.channel === m[1] && /^\/rules(\/|$)/.test(m[2] || '')) { problem(res, 403, 'person_only', 'Only the person adds, changes or removes a standing rule. A session can read the list.'); return; }
  if (!authorized(req, url) && !tokenMay && agent && agent.channel === m[1] && /^\/tickets\/[\w-]{1,64}\/edit$/.test(m[2] || '')) { problem(res, 403, 'forbidden', 'Only the person, the PM and the Lead edit a ticket.'); return; }
  if (!authorized(req, url) && !tokenMay && agent && agent.channel === m[1] && /^\/tickets\/[\w-]{1,64}\/propose$/.test(m[2] || '')) { problem(res, 403, 'forbidden', 'Only the PM and the Lead propose to replace, merge or close a ticket, or to change its blockers. File a ticket instead.'); return; }
  if (!authorized(req, url) && agent && agent.role === 'pm' && agent.channel === m[1] && /^\/tickets\/[\w-]{1,64}\/(move|start)$/.test(m[2] || '')) { problem(res, 403, 'forbidden', 'The PM does not move or start a ticket, or change its base or kind. It edits the title and body of tickets in Triage or Ready, and with PM trust at Order or above, their priority and place.'); return; }
  if (!authorized(req, url) && !tokenMay && agent && agent.channel === m[1] && m[2] === '/jams') { problem(res, 403, 'person_only', 'Only the person writes or reads the jam log.'); return; }
  if (!authorized(req, url) && !tokenMay && agent && m[2] === '/floor') { problem(res, 401, 'unauthorized', 'Only the Lead can read the floor.'); return; }
  if (!authorized(req, url) && !tokenMay) { problem(res, 401, 'unauthorized', agent ? 'This session can only list and file tickets, and read and post on the chat board. Only a Lead you have let move the board can do that, and only one you have let start tickets can start one.' : (givenKey(req, url) ? 'That key is not this relay\'s key. Use the key the relay was started with (RELAY_KEY): the link npm run office prints has it, after key=.' : 'Send the relay key as "Authorization: Bearer <key>" or ?key=<key>, or open the room page with the key once to get its cookie.')); return; }
  let name = '';
  try { name = decodeURIComponent(m[1]); } catch { name = ''; }
  const rest = m[2] || '';
  if (!CHANNEL_RE.test(name)) { problem(res, 400, 'bad_channel', 'A channel name is 1 to 64 letters, numbers, dashes or underscores.'); return; }
  const ch = channel(name);

  try {
    const asked = api.requestSchema(req.method, rest);
    const body = asked ? await readJson(req) : undefined;
    const wrong = asked ? api.check(asked.schema, body, { typesOnly: true }) : [];
    if (wrong.length) { problem(res, 400, 'bad_type', wrong[0]); return; }
    const bodyOf = asked ? () => Promise.resolve(body) : readJson;
    const ctx = { port: PORT, key: KEY, agent, send, problem, readJson: bodyOf, log, command: (c, cmd) => sendCommand(channel(c), cmd) };
    for (const part of ROUTES) if (await part.handle(req, res, name, rest, ctx)) return;
    if (req.method === 'GET' && rest === '') {
      send(res, 200, { ok: true, channel: name, pagesConnected: ch.pages.length, pagesVisible: visibleCount(ch), lastSeen: ch.lastSeen,
        pending: [...ch.results.values()].filter((r) => r.status === 'pending').length, events: ch.events.length, lastEventSeq: ch.rseq });
      return;
    }
    if (req.method === 'GET' && rest === '/stream') { openStream(req, res, ch, url); return; }

    if (req.method === 'POST' && rest === '/results') {
      const body = await readJson(req);
      if (!body.id || !ch.results.has(body.id)) { problem(res, 404, 'unknown_command', 'No command with that id.'); return; }
      finish(ch, body.id, body.result && typeof body.result === 'object' ? body.result : { ok: false, error: 'bad_result', message: 'The page sent no result.' });
      send(res, 200, { ok: true });
      return;
    }
    const pm = rest.match(/^\/pages\/(\d+)$/);
    if (req.method === 'POST' && pm) {
      const body = await readJson(req);
      const page = ch.pages.find((p) => p.id === Number(pm[1]));
      if (!page) { problem(res, 404, 'unknown_page', 'No page with that id on this channel.'); return; }
      const visible = body.visible !== false;
      if (page.visible !== visible) log('page on', name, visible ? 'is on screen' : 'is hidden, so its world is paused');
      page.visible = visible;
      send(res, 200, { ok: true, page: page.id, visible });
      return;
    }
    if (req.method === 'POST' && rest === '/events') {
      const body = await readJson(req);
      addEvents(ch, Array.isArray(body.events) ? body.events : []);
      send(res, 200, { ok: true, lastEventSeq: ch.rseq });
      return;
    }

    if (req.method === 'POST' && rest === '/commands') {
      const command = Object.assign({}, await bodyOf(req));
      const wait = command.wait !== undefined ? command.wait !== false && command.wait !== 'false' : url.searchParams.get('wait') !== 'false';
      const timeout = Math.min(120, Math.max(1, Number(command.timeout || url.searchParams.get('timeout') || 30)));
      delete command.wait; delete command.timeout;
      if (!command.action || typeof command.action !== 'string') { problem(res, 400, 'bad_command', 'The body needs an "action", for example {"action": "add", "thing": "dog"}.'); return; }
      if (agent) {
        const ev = command.event && typeof command.event === 'object' ? command.event : null, sid = ev ? String(ev.session_id || '') : '';
        if (command.action !== 'hook' || !ev || !sid || (ev.hook_event_name !== 'SessionStart' && !agent.sessionId.startsWith(sid))) { problem(res, 403, 'forbidden', 'A session\'s token sends only the hooks of its own session.'); return; }
        command.event = Object.assign({}, ev, { terminal: agent.id });
      }
      if (office && command.action === 'hook' && command.event && typeof command.event === 'object' && office.games.isSeat({ id: command.event.terminal }, name)) {
        command.event = require('./round-seats.js').quiet(command.event);
      }
      if (command.action === 'hook') {
        if (office && !office.terminal.localOnly(req, PORT)) {
          if (hookQueue.waiting(stateDir())) replayHooks(hookQueue.take(stateDir()));
          noteHook(name, command.event);
        }
      }
      const id = sendCommand(ch, command);
      if (!id) { problem(res, 503, 'no_page', 'No page is connected to channel "' + name + '". Open the world with ?channel=' + name + '&key=<key>.'); return; }
      log(name, '<-', JSON.stringify(command));
      if (!wait) { send(res, 202, { ok: true, id, channel: name, status: 'pending' }); return; }
      const entry = await new Promise((resolve) => {
        const timer = setTimeout(() => { ch.pending.delete(id); resolve(null); }, timeout * 1000);
        ch.pending.set(id, (e) => { clearTimeout(timer); resolve(e); });
      });
      if (!entry) {
        const sent = ch.results.get(id), hidden = !!(sent && sent.page && !sent.page.visible);
        problem(res, 504, 'timeout', 'The page did not answer within ' + timeout + ' seconds. ' + (hidden
          ? 'Its tab is hidden, so the world is paused. Bring the world\'s tab to the front.'
          : 'The world only runs while its page is on screen.'), { id, pageHidden: hidden });
        return;
      }
      log(name, '->', JSON.stringify(entry.result));
      send(res, 200, reply(entry, ch));
      return;
    }
    const cm = rest.match(/^\/commands\/([0-9a-f-]{36})$/);
    if (req.method === 'GET' && cm) {
      const entry = ch.results.get(cm[1]);
      if (!entry) { problem(res, 404, 'unknown_command', 'No command with that id.'); return; }
      send(res, 200, entry.status === 'done' ? Object.assign({ status: 'done' }, reply(entry, ch)) : { ok: true, id: entry.id, status: 'pending' });
      return;
    }
    if (req.method === 'GET' && rest === '/events') {
      const since = Number(url.searchParams.get('since') || 0);
      const types = (url.searchParams.get('types') || '').split(',').map((s) => s.trim()).filter(Boolean);
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 200)));
      const list = ch.events.filter((e) => e.rseq > since && (!types.length || types.includes(e.type))).slice(0, limit);
      send(res, 200, { ok: true, channel: name, events: list, lastEventSeq: ch.rseq });
      return;
    }
    problem(res, 404, 'not_found', 'Unknown route. See RELAY.md.');
  } catch (err) {
    problem(res, err.status || 500, err.status ? 'bad_request' : 'error', err.message);
  }
}

const hookQueue = require('./hook-queue.js');
const stateDir = () => require('./state.js').dir();
let hooksOpen = false;
const earlyHooks = [];
function noteHook(name, event) {
  for (const k of ['terminal', 'tasks', 'prComments', 'huddles', 'reviews', 'coo', 'security', 'chat']) office[k].noteHook(name, event);
}
const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]']);
function replayHooks(entries) {
  let applied = 0;
  for (const e of entries) {
    let to;
    try { to = new URL(e.to); } catch (err) { continue; }
    const cm = to.pathname.match(/^\/channels\/([^/]+)\/commands$/);
    if (!cm || !LOCAL.has(to.hostname) || Number(to.port) !== PORT) continue;
    let name;
    try { name = decodeURIComponent(cm[1]); } catch (err) { continue; }
    if (!CHANNEL_RE.test(name)) continue;
    const event = Object.assign({}, e.event);
    if (e.auth !== hookQueue.hash(KEY)) {
      const t = office.terminal.everyone().find((x) => x.token && hookQueue.hash(x.token) === e.auth), sid = String(event.session_id || '');
      if (!t || t.channel !== name || !sid || (event.hook_event_name !== 'SessionStart' && !t.sessionId.startsWith(sid))) continue;
      event.terminal = t.id;
    }
    noteHook(name, event);
    sendCommand(channel(name), { action: 'hook', event, source: 'claude-code' });
    applied++;
  }
  if (entries.length) log('Hooks sent while the relay was away: applied ' + applied + ' of ' + entries.length + '.');
}

const server = http.createServer((req, res) => { handle(req, res).catch((err) => problem(res, 500, 'error', err.message)); });
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' is already in use, probably by a relay that is still running.');
    console.error('Stop it (find it with: lsof -i :' + PORT + '), or start this one on another port, for example: PORT=' + (PORT + 1) + ' npm run relay');
  } else {
    console.error('The relay could not start: ' + err.message);
  }
  process.exit(1);
});
server.listen(PORT, HOST, async () => {
    console.log('Relay on http://' + HOST + ':' + PORT);
    console.log('Key: ' + KEY + (KEY_GIVEN ? '' : '  (random; set RELAY_KEY to choose one)'));
    for (const w of ONE ? [ONE] : worlds()) console.log('Open ' + w.name + ': http://localhost:' + PORT + '/' + w.dir + '/?channel=' + encodeURIComponent(w.channel) + '&key=' + KEY);
    if (WEBHOOK_URL) console.log('Webhook: ' + WEBHOOK_URL + ' for ' + WEBHOOK_TYPES.join(', '));
    if (!office) return;
    const { terminal, chat, sessions, reviews, autopilot, checkouts, leadCheck, pmSort } = office;
    if (terminal.ENABLED) console.log('Claude Code panel: on, for the room page on this computer only.');
    // The sweep must run after restoreAll, and works only because terminal.start is synchronous: a restored
    // session is in runningIn at once, so its checkout is kept. If start ever becomes async, await
    // the restore first, or the sweep removes a checkout a reviewer is coming back to.
    chat.started();
    if (terminal.ENABLED) {
      try { await terminal.connectHost(log); } catch (e) { console.error(e.message); process.exit(1); }
    }
    await office.oldRelays.begin({ port: PORT, defaultPort: (ONE && ONE.port) || 8787, host: HOST, world: WORLD, log });
    sessions.restoreAll({ port: PORT, key: KEY, log, command: (c, cmd) => sendCommand(channel(c), cmd) });
    sessions.startLead(LEAD_CHANNEL, { port: PORT, key: KEY, log, command: (c, cmd) => sendCommand(channel(c), cmd) });
    require('./pm-seat.js').begin(LEAD_CHANNEL, { port: PORT, key: KEY, log, command: (c, cmd) => sendCommand(channel(c), cmd) });
    office.metrics.start(LEAD_CHANNEL);
    reviews.begin({ port: PORT, key: KEY, log, command: (c, cmd) => sendCommand(channel(c), cmd) });
    autopilot.begin({ port: PORT, key: KEY, log, command: (c, cmd) => sendCommand(channel(c), cmd) });
    office.update.begin({ port: PORT, key: KEY, log });
    office.prWatch.begin({ log });
    require('./stuck-jobs.js').begin();
    office.managerWatch.begin({ log });
    office.tasks.begin({ log });
    office.ready.begin({ log });
    office.failures.begin();
    office.flake.begin();
    office.leadStuck.begin();
    office.awake.begin({ log });
    // Replayed after reviews.begin, or reviews would ignore a queued PR or push.
    hooksOpen = true;
    replayHooks(hookQueue.take(stateDir()).concat(earlyHooks.splice(0)).sort((a, b) => a.event.at - b.event.at));
    setTimeout(() => replayHooks(hookQueue.take(stateDir())), 3000).unref();
    require('./stuck.js').begin();
    require('./github-pass.js').begin();
    leadCheck.begin();
    pmSort.begin();
    checkouts.sweep().catch((e) => log('Could not tidy the checkouts: ' + e.message));
  });

const stopAll = () => { if (office) { office.awake.release(); office.terminal.close(); } };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stopAll(); process.exit(0); });
process.on('exit', stopAll);
const supervisor = process.ppid;
setInterval(() => { if (process.ppid !== supervisor) { log('The supervisor is gone, so the relay stops.'); stopAll(); process.exit(0); } }, 2000).unref();
