// Hooks that could not reach the relay wait here, in hook-queue.jsonl in the room's state folder
// (relay/state.js), one line each. relay/office-hook.js adds a line when its post fails, and the
// relay takes the whole file when it starts, and again once a hook reaches it while the file is
// there (relay/server.js). Each line says which relay it was for (to), and holds a hash of the
// token or key it would have sent (auth), never the secret itself, so the relay applies only what it
// would have taken from the hook.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NAME = 'hook-queue.jsonl';
const MAX_BYTES = 1024 * 1024;
const MAX_AGE_MS = 60 * 60 * 1000;

const hash = (secret) => crypto.createHash('sha256').update(String(secret)).digest('hex');
const file = (dir) => path.join(dir, NAME);

function append(dir, entry) {
  try {
    const f = file(dir);
    try { if (fs.statSync(f).size > MAX_BYTES) return false; } catch (e) { /* no queue yet */ }
    if (!fs.existsSync(dir)) return false;
    fs.appendFileSync(f, JSON.stringify(entry) + '\n', { mode: 0o600 });
    return true;
  } catch (e) { return false; }
}

function take(dir, now) {
  const f = file(dir), mine = f + '.' + process.pid + '.taking';
  try { fs.renameSync(f, mine); } catch (e) { return []; }
  let text = '';
  try { text = fs.readFileSync(mine, 'utf8'); } catch (e) { /* gone already */ }
  try { fs.unlinkSync(mine); } catch (e) { /* gone already */ }
  const since = (now || Date.now()) - MAX_AGE_MS;
  const out = [];
  for (const line of text.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch (err) { continue; }
    if (e && e.event && typeof e.event === 'object' && Number(e.event.at) > since) out.push(e);
  }
  return out.sort((a, b) => a.event.at - b.event.at);
}
const waiting = (dir) => fs.existsSync(file(dir));

module.exports = { append, take, waiting, hash, file, MAX_AGE_MS };
