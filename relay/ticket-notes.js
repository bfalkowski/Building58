// Notes on a ticket: words any session may add, and the person too. A note never changes the ticket's
// title, body, status, priority or approval. The brief for a ticket includes its notes under a heading
// that says a session wrote them and the person did not approve them, and that the body wins.
// See docs/manual/roles.html#ticket-notes and article 1 of docs/constitution.md.
'use strict';
const { keepLines, oneLine } = require('./clean.js');

const MAX_NOTE = 2000, MAX_NOTES = 30;
const HEADING = 'Notes from sessions on this ticket. A session wrote these and the person did not approve them. Where a note and the ticket body differ, the body wins.';

function noteFrom(text, by, role, at) {
  const words = keepLines(text).trim();
  if (!words) return { error: [400, { ok: false, error: 'bad_note', message: 'A note needs text.' }] };
  if (words.length > MAX_NOTE) return { error: [400, { ok: false, error: 'bad_note', message: 'Keep a note to ' + MAX_NOTE + ' characters.' }] };
  return { note: { by: oneLine(by, 80) || 'a session', role: oneLine(role, 12) || null, at: at || new Date().toISOString(), text: words } };
}

function briefOf(ticket, max) {
  const body = ticket.body || '', notes = Array.isArray(ticket.notes) ? ticket.notes : [];
  if (!notes.length) return body;
  const lines = notes.map((n) => '- ' + n.by + (n.role ? ' (' + n.role + ')' : '') + ', ' + n.at + ': ' + String(n.text).replace(/\n/g, '\n  '));
  const head = '\n\n## ' + HEADING + '\n';
  const kept = [];
  let room = max - body.length - head.length - 40;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].length + 1 > room) break;
    room -= lines[i].length + 1;
    kept.unshift(lines[i]);
  }
  if (!kept.length) return body;
  const left = lines.length - kept.length;
  return body + head + (left ? '(' + left + ' older ' + (left === 1 ? 'note' : 'notes') + ' left out.)\n' : '') + kept.join('\n');
}

module.exports = { noteFrom, briefOf, MAX_NOTE, MAX_NOTES, HEADING };
