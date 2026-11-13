// The boundary a seat of a round runs inside (relay/games.js). A seat is a Claude Code session with a
// shell, run as the person's own user, so without a boundary it could read the games repo, the games'
// sealed truth, the relay's state, the other seats' folders and transcripts, and the person's own work.
//
// On macOS the relay starts each seat's claude inside sandbox-exec, with a profile made for that seat.
// The profile allows everything, then refuses reads and writes of these places, then allows back the
// seat's own share of them:
//   GAMES_REPO, and the games' sealed folder (GAMES_HOME, or ~/.games)
//   the relay's state folder. The seat keeps its own folder, and may add to the hook queue (write only).
//   in ~/.claude: projects (transcripts), todos, file-history, session-env, plans and history.jsonl
//     (the prompts of every session, a seat's brief among them). The seat keeps its own transcript
//     folder and the files named with its own session id.
//   every path in RELAY_SEAT_DENY, split like PATH
// The limits run in every process the seat starts, its shell and tools included.
//
// What it does not cover: the network, the rest of the person's files that are not in that list, and
// ~/.claude's other shared folders (shell-snapshots, for one). Those are the same as for any session.
//
// Where sandbox-exec is missing, a round is refused, unless the person sets RELAY_SEAT_ISOLATION=off.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = '/usr/bin/sandbox-exec';

// 'sandbox' when seats get the boundary, 'none' when the person turned it off, or null when it is
// needed and missing.
function mode() {
  if (process.env.RELAY_SEAT_ISOLATION === 'off') return 'none';
  return process.platform === 'darwin' && fs.existsSync(SANDBOX) ? 'sandbox' : null;
}

// The real path, as the kernel sees it (/var is /private/var on macOS), also for a path not made yet.
function real(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch (e) { /* not there yet */ }
  const parent = path.dirname(abs);
  return parent === abs ? abs : path.join(real(parent), path.basename(abs));
}
// Claude Code keeps a folder's transcripts in ~/.claude/projects/<the path with each sign as a dash>.
const projectFolder = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
const str = (s) => JSON.stringify(s);  // a string in the profile's language takes the same escapes
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// What a seat may not touch, and what it keeps, for a seat in folder seatDir with session sessionId.
function places({ seatDir, sessionId, stateDir, home, env }) {
  home = real(home || os.homedir());
  env = env || process.env;
  const claude = path.join(home, '.claude');
  const deny = [];
  if (env.GAMES_REPO) deny.push(real(env.GAMES_REPO));
  deny.push(real(env.GAMES_HOME || path.join(home, '.games')));
  deny.push(real(stateDir));
  for (const k of ['projects', 'todos', 'file-history', 'session-env', 'plans', 'history.jsonl']) deny.push(path.join(claude, k));
  for (const p of String(env.RELAY_SEAT_DENY || '').split(path.delimiter).filter(Boolean)) deny.push(real(p));
  const own = real(seatDir);
  const keep = [own, path.join(claude, 'projects', projectFolder(own))];
  const keepIds = ['todos', 'file-history', 'session-env'].map((k) => path.join(claude, k));
  return { deny, keep, keepIds, sessionId, queue: path.join(real(stateDir), 'hook-queue.jsonl'), stateDir: real(stateDir), claude };
}

// The sandbox-exec profile for one seat. Later rules win over earlier ones.
function profile(opts) {
  const p = places(opts);
  const lines = ['(version 1)', '(allow default)'];
  for (const d of p.deny) lines.push('(deny file-read* file-write* (subpath ' + str(d) + '))');
  for (const k of p.keep) lines.push('(allow file-read* file-write* (subpath ' + str(k) + '))');
  if (p.sessionId) for (const k of p.keepIds) lines.push('(allow file-read* file-write* (regex ' + str('^' + rx(k + '/') + rx(p.sessionId)) + '))');
  // The folders above the seat's own, and the hook queue: their names and sizes only, and the queue
  // may be added to. Nothing in them can be read.
  for (const k of [p.stateDir, path.join(p.stateDir, 'seats'), path.dirname(p.keep[0]), path.join(p.claude, 'projects')]) lines.push('(allow file-read-metadata (literal ' + str(k) + '))');
  lines.push('(allow file-read-metadata file-write* (literal ' + str(p.queue) + '))');
  return lines.join('\n');
}

// The command that starts cmd inside the seat's boundary, or cmd as it is with the boundary off.
function wrap(cmd, opts) {
  const m = mode();
  if (m === 'none') return cmd;
  if (m !== 'sandbox') throw new Error('Seats need sandbox-exec, which this computer does not have. Set RELAY_SEAT_ISOLATION=off to run rounds without it.');
  return [SANDBOX, '-p', profile(opts)].concat(cmd);
}

module.exports = { mode, wrap, profile, places, projectFolder };
