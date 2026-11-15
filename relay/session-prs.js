// The PR of each session with no task, such as one from Add worker, that relay/pr-comments.js watches
// for review news (T-293). A task keeps this on itself in tasks.json; a session with no task has nowhere
// to keep it, so it lives here, in session-prs.json, and survives a restart.
//
// Each watch is shaped like a task, so relay/pr-comments.js can treat both the same:
//   { session: true, id, pr, owner: { terminal, sessionId }, state, reviews, history }
// id is 'session-' and the full session id. One watch per session: a second PR from the same session
// replaces the first. relay/pr-comments.js ends a watch when the person stops the session, or when gh
// says the PR is merged or closed.
//   list(channel)               the watches on a channel
//   channels()                  the channels with a watch
//   watch(channel, t, pr)       watches pr for the room session t, and gives the watch back
//   end(channel, id)            stops watching, and gives the watch back, or null
//   record(w, entry)            adds a line to the watch's short history
//   save()
'use strict';
const fs = require('fs');
const path = require('path');
const state = require('./state.js');
const { claim } = require('./lockfile.js');

const FILE = state.file('session-prs.json', 'RELAY_SESSION_PRS_FILE');
const MAX_HISTORY = 20;

const ownsFile = claim(FILE);
let store = {};
if (ownsFile) try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) {
  if (e.code !== 'ENOENT') {
    const aside = FILE + '.unreadable-' + Date.now();
    try { fs.renameSync(FILE, aside); console.error('Could not read ' + FILE + '. Kept it as ' + aside); } catch (e2) { console.error('Could not read ' + FILE + ': ' + e.message); }
  }
}
function save() {
  if (!ownsFile) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('Could not save the session PRs to ' + FILE + ': ' + e.message); }
}
const list = (channel) => store[channel] || [];
const channels = () => Object.keys(store).filter((c) => list(c).length);
const now = () => new Date().toISOString();
function record(w, entry) {
  w.history.push(Object.assign({ at: now() }, entry));
  if (w.history.length > MAX_HISTORY) w.history.splice(0, w.history.length - MAX_HISTORY);
}
function watch(channel, t, pr) {
  const id = 'session-' + t.sessionId;
  const old = list(channel).find((w) => w.id === id);
  if (old && old.pr === pr) return old;
  const w = { session: true, id, pr, owner: { terminal: t.id, sessionId: t.sessionId }, state: 'building', reviews: null, history: [], since: now() };
  store[channel] = list(channel).filter((x) => x.id !== id).concat([w]);
  record(w, { type: 'pr', pr });
  save();
  return w;
}
function end(channel, id) {
  const w = list(channel).find((x) => x.id === id);
  if (!w) return null;
  store[channel] = list(channel).filter((x) => x !== w);
  if (!store[channel].length) delete store[channel];
  save();
  return w;
}

module.exports = { list, channels, watch, end, record, save };
