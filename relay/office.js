#!/usr/bin/env node
// Opens the room with one command.
//
//   RELAY_KEY=pick-a-key npm run office         relay + room page, then leave it running
//   RELAY_KEY=pick-a-key npm run office:demo    the same, then play pretend Claude Code sessions
//
// 1. It uses the relay at RELAY_URL if one is running there. If none is, it starts one for the
//    room alone (RELAY_WORLD=office), so other worlds run on relays of their own.
//    With --demo, that relay stops when the demo ends; without it, Ctrl+C stops it.
// 2. If no room page on channel CHANNEL is connected and on screen, it opens one in your
//    browser and waits for it to connect.
// 3. With --demo, it sends the sessions in office/demo-session.js through the relay, as the
//    real hook (relay/office-hook.js) would, one event at a time.
//
// Optional: RELAY_URL (default http://localhost:8787), CHANNEL (default room),
// DEMO_SPEED (default 1; 2 plays it twice as fast), OPEN_CMD (the command that opens a link).
'use strict';
const { spawn, execFile } = require('child_process');
const os = require('os');
const path = require('path');
const state = require('./state.js');
const { hookHint } = require('./office-hint.js');

const RELAY = (process.env.RELAY_URL || 'http://localhost:8787').replace(/\/+$/, '');
const CHANNEL = process.env.CHANNEL || 'office';
const KEY = process.env.RELAY_KEY;
const DEMO = process.argv.includes('--demo');
const SPEED = Math.max(0.1, Number(process.env.DEMO_SPEED || 1));
if (!KEY) { console.error('Set RELAY_KEY to a key, for example: RELAY_KEY=pick-a-key npm run office' + (DEMO ? ':demo' : '')); process.exit(1); }
const PAGE = RELAY + '/office/?channel=' + encodeURIComponent(CHANNEL) + '&key=' + encodeURIComponent(KEY);
const AUTH = { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(p) {
  try { const r = await fetch(RELAY + p, { headers: AUTH, signal: AbortSignal.timeout(2000) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }
  catch (e) { return { status: 0, error: e.cause && e.cause.code || e.name }; }
}

// The demo's relay brings back no session, and keeps any it starts in a list of its own, so it can
// neither bring back nor overwrite the room's real sessions.
const DEMO_ENV = { RELAY_RESUME: '0', RELAY_SESSIONS_FILE: path.join(os.tmpdir(), 'office-demo-' + process.pid, 'sessions.json') };
let child = null;
function stopRelay() { if (child && !child.killed) { child.kill(); console.log('Stopped the relay this script started.'); } }
process.on('SIGINT', () => { stopRelay(); process.exit(130); });
process.on('SIGTERM', () => { stopRelay(); process.exit(143); });

(async () => {
  // ---------- 1. the relay ----------
  const h = await get('/health');
  if (h.status === 200) console.log('Using the relay that is running at ' + RELAY + '.');
  else if (h.error === 'TimeoutError') {
    const port = new URL(RELAY).port || '80';
    console.log('Something on port ' + port + ' accepts connections but does not answer. It is probably an old');
    console.log('relay that was paused with Ctrl+Z. Stop it with this command, then run this again:');
    console.log('  lsof -t -i tcp:' + port + ' -sTCP:LISTEN | xargs kill -9');
    process.exit(1);
  } else {
    const u = new URL(RELAY);
    if (!['localhost', '127.0.0.1'].includes(u.hostname)) { console.log('No relay answers at ' + RELAY + '.'); process.exit(1); }
    child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, Object.assign({ PORT: u.port || '8787', RELAY_KEY: KEY, RELAY_TERMINAL: '1', RELAY_WORLD: 'office' }, DEMO ? DEMO_ENV : {})), stdio: DEMO ? 'ignore' : ['ignore', 'inherit', 'inherit'] });
    for (let i = 0; i < 20 && (await get('/health')).status !== 200; i++) await sleep(250);
    if ((await get('/health')).status !== 200) { console.log('Could not start a relay on port ' + (u.port || 8787) + '.'); stopRelay(); process.exit(1); }
    console.log('Started a relay on port ' + (u.port || 8787) + '. ' + (DEMO ? 'It stops when the demo ends.' : 'Press Ctrl+C to stop it.'));
  }
  const ch = await get('/channels/' + CHANNEL);
  if (ch.status === 401) { console.log('The relay at ' + RELAY + ' has a different key. Use the key it printed when it started.'); stopRelay(); process.exit(1); }

  // ---------- 2. the page ----------
  if (!(ch.body && ch.body.pagesVisible > 0)) {
    const opener = process.env.OPEN_CMD || (process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open');
    console.log('Opening the office: ' + PAGE);
    execFile(opener, [PAGE], () => {});
    let ok = false;
    for (let i = 0; i < 120 && !ok; i++) { await sleep(500); const c = await get('/channels/' + CHANNEL); ok = c.body && c.body.pagesVisible > 0; }
    if (!ok) { console.log('The room page did not connect within a minute. Open this link and keep it on screen:\n  ' + PAGE); if (DEMO) { stopRelay(); process.exit(1); } }
    else console.log('The room is connected.');
  } else console.log('A room page is already connected on channel "' + CHANNEL + '".');

  if (!DEMO) {
    console.log('\n' + hookHint(RELAY, state.dir(), CHANNEL));
    if (!child) process.exit(0);
    return;  // keep the relay this script started running until Ctrl+C
  }

  // ---------- 3. the demo session ----------
  const steps = require(path.join(__dirname, '..', 'office', 'demo-session.js'))();
  console.log('\nPlaying a pretend session of ' + steps.length + ' hook events' + (SPEED !== 1 ? ' at ' + SPEED + 'x' : '') + '.');
  const t0 = Date.now();
  for (const [at, event] of steps) {
    const wait = t0 + (at * 1000) / SPEED - Date.now(); if (wait > 0) await sleep(wait);
    let r;
    try {
      const res = await fetch(RELAY + '/channels/' + CHANNEL + '/commands', { method: 'POST', headers: AUTH, body: JSON.stringify({ action: 'hook', event, source: 'demo', timeout: 10 }) });
      r = await res.json();
    } catch (e) { r = { ok: false, message: e.message }; }
    const what = event.hook_event_name + (event.tool_name ? ' ' + event.tool_name : '') + (event.tool_input && event.tool_input.skill ? ' /' + event.tool_input.skill : '') + (event.tool_input && event.tool_input.subagent_type ? ' ' + event.tool_input.subagent_type : '');
    console.log(String(at).padStart(4) + 's  ' + what.padEnd(36) + ' ' + (r.ok ? (r.who ? '-> ' + r.who : '') : 'failed: ' + (r.message || r.error)));
    if (!r.ok && r.error === 'no_page') { console.log('The room page closed.'); break; }
  }
  stopRelay();
})();
