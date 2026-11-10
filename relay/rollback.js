// The way back from a relay that fails on new code. The supervisor (relay/supervisor.js) loads this
// once, so a broken relay cannot break it. While RELAY_ROLLBACK=1, each time it starts the relay it
// checks that the relay answers /health, serves the room page, and brings back the sessions it
// saved, within RELAY_ROLLBACK_SECONDS. A pass records the commit as the last good one, in
// good-commit.json in the state folder. A fail after an Update's restart checks that commit out in the
// relay's folder and starts the relay again on it, at most once in a row, and never over changes to
// tracked files. The relay that comes back tells the page (relay/update.js). See
// docs/manual/running.html#rollback.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const state = require('./state.js');

const ON = () => process.env.RELAY_ROLLBACK === '1';
const WITHIN = () => Math.max(5, Number(process.env.RELAY_ROLLBACK_SECONDS) || 60) * 1000;
const FILE = () => state.file('good-commit.json', 'RELAY_GOOD_FILE');
// The folder Update pulls into, as relay/update.js has it.
const DIR = () => path.resolve(process.env.RELAY_UPDATE_DIR || path.join(__dirname, '..'));

const git = (args) => execFileSync('git', args, { cwd: DIR(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }).trim();
function head() { try { return git(['rev-parse', 'HEAD']); } catch (e) { return null; } }
// Changes to tracked files, staged or not. Files git does not track stop a checkout only if one is in its way.
function changed() { try { return git(['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean); } catch (e) { return []; } }

// The record for this relay's folder. One left by a relay in another folder, such as another
// checkout of this repo, is not this folder's, so it reads as none.
function read() {
  try { const s = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return s && typeof s === 'object' && s.dir === DIR() ? s : {}; } catch (e) { return {}; }
}
function write(state) {
  const file = FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
// A pass. A rollback stays on record while the relay runs the commit it went back to.
function passed(commit) {
  const was = read();
  write(Object.assign({ dir: DIR(), commit, at: new Date().toISOString() }, was.rollback && was.rollback.running === commit ? { rollback: was.rollback } : {}));
}

// Whether a failed check rolls back, and why not. Pure, so the rules are tested on their own.
// newCode: this start followed an Update's restart. again: this start was itself a rollback.
function plan({ newCode, again, good, head: now, dirty }) {
  if (!newCode) return { rollback: false, why: 'This start did not follow an Update, so there is nothing to go back from.' };
  if (again) return { rollback: false, why: 'It already rolled back once, and rolls back only once in a row.' };
  if (!good) return { rollback: false, why: 'No commit has passed the check yet, so there is none to go back to.' };
  if (good === now) return { rollback: false, why: 'The commit that failed is the last one that passed, so there is nothing older to go back to.' };
  if (dirty && dirty.length) return { rollback: false, why: 'The relay\'s folder has changes to tracked files (' + dirty.join(', ') + '), and a rollback never touches them.' };
  return { rollback: true, why: null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, key) {
  try {
    const r = await fetch(url, { headers: key ? { Authorization: 'Bearer ' + key } : {}, signal: AbortSignal.timeout(3000) });
    return { status: r.status, text: await r.text() };
  } catch (e) { return null; }
}
// The address to check. The relay answers its key with restore only from this computer, so a HOST
// that is not a loopback address is checked at 127.0.0.1, which a relay bound only to it never answers.
function host() {
  const h = String(process.env.HOST || '127.0.0.1').replace(/^\[|\]$/g, '');
  return h === '::1' ? '[::1]' : h === 'localhost' ? 'localhost' : '127.0.0.1';
}
// Resolves to { ok, why } within the time limit. alive() says the relay process is still running.
async function check({ port, key, alive, within }) {
  const base = 'http://' + host() + ':' + port, limit = within || WITHIN(), end = Date.now() + limit;
  let why = 'it did not answer /health within ' + Math.round(limit / 1000) + ' seconds';
  while (Date.now() < end) {
    if (!alive()) return { ok: false, why: 'it stopped before it passed' };
    const h = await get(base + '/health', key);
    let body = null;
    try { body = h && h.status === 200 ? JSON.parse(h.text) : null; } catch (e) { /* not JSON */ }
    if (h && !body) why = '/health answered ' + h.status;
    else if (body && !(body.restore && body.restore.done)) why = 'it had not finished bringing back its sessions';
    else if (body) {
      const failed = body.restore.failed || [];
      if (failed.length) return { ok: false, why: 'it could not bring back ' + failed.length + ' of its ' + body.restore.saved + ' saved sessions: ' + failed.map((f) => f.who + ' (' + f.why + ')').join(', ') };
      const page = await get(base + '/office/');
      if (page && page.status === 200 && /<html/i.test(page.text)) return { ok: true };
      why = 'it answered /health but not the room page' + (page ? ' (' + page.status + ')' : '');
    }
    await sleep(500);
  }
  return { ok: false, why };
}

// Whether the folder is on a branch. After a rollback it is not, until a person checks one out.
function onBranch() { try { git(['symbolic-ref', '-q', 'HEAD']); return true; } catch (e) { return false; } }
// Goes back to the commit. Throws, and touches nothing, if git refuses.
function checkout(commit) { git(['-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', commit]); }
function noteRollback(failed, running, why) {
  write({ dir: DIR(), commit: running, at: read().at || null, rollback: { failed, running, why, at: new Date().toISOString() } });
}

module.exports = { ON, WITHIN, FILE, DIR, head, changed, onBranch, read, passed, plan, check, checkout, noteRollback };
