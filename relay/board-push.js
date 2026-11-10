// The Board, pushed. The room page already holds an event stream to the relay (relay/server.js,
// GET /stream). While it is open, the relay looks at the Board once a second, here in the relay, and
// sends it on that stream as a tickets event only when something the Board draws has changed. A write
// through the tickets routes looks at once. So the page does not ask for GET /tickets while its stream
// is open (office/tickets.js).
//
// Like the tickets routes, this is only for the room page on this computer, and only with the terminal on.
'use strict';
const terminal = require('./terminal.js');
const tickets = require('./tickets.js');
const floor = require('./floor.js');

const EVERY_MS = 1000;
// channel -> { pages: Set of responses, last: the text last sent, busy, again, failing, log }
const watched = new Map();

// What the Board draws, as one line of text. The time a pipeline was last checked is left out: the
// Board does not show it, and it changes on every check.
async function snapshot(channel) {
  const b = await tickets.board(channel);
  for (const t of b.tickets) if (t.task && t.task.pipeline) { const p = Object.assign({}, t.task.pipeline); delete p.at; t.task.pipeline = p; }
  b.people = floor.seatsOf(channel);
  return JSON.stringify(b);
}
const write = (res, text) => res.write('event: tickets\ndata: ' + text + '\n\n');

// Looks at a channel's Board, and sends it to every page there if it changed. One look at a time; a
// change asked for during one looks again after it.
async function look(channel) {
  const w = watched.get(channel);
  if (!w) return;
  if (w.busy) { w.again = true; return; }
  w.busy = true;
  try {
    const text = await snapshot(channel);
    w.failing = false;
    if (text !== w.last) { w.last = text; for (const res of w.pages) write(res, text); }
  } catch (e) {
    if (!w.failing) w.log('Could not push the Board: ' + (e && e.message) + '. It tries again each second.');  // said once, not each second
    w.failing = true;
  } finally {
    w.busy = false;
    if (w.again) { w.again = false; look(channel); }
  }
}

// Whether a page's stream gets the Board. The page is told in its hello.
const sends = (req, port) => terminal.ENABLED && !terminal.localOnly(req, port);
// A page that sends() allows opened its stream, and has had its hello. Its first tickets event follows at once.
function watch(req, res, channel, log) {
  let w = watched.get(channel);
  if (!w) {
    w = { pages: new Set(), last: null, busy: false, again: false, failing: false, log };
    w.timer = setInterval(() => look(channel), EVERY_MS); w.timer.unref();
    watched.set(channel, w);
  }
  w.pages.add(res);
  if (w.last != null) write(res, w.last); else look(channel);
  req.on('close', () => {
    w.pages.delete(res);
    if (!w.pages.size) { clearInterval(w.timer); watched.delete(channel); }
  });
}
tickets.onChange((channel) => look(channel));

module.exports = { sends, watch, EVERY_MS };
