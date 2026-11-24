// Notes on a ticket: words any session adds without editing the ticket. A note never changes the title,
// body, status, priority or approval, so it is not the person's approved text. The brief of a ticket
// that starts carries its notes under a heading that says so. See docs/manual/roles.html#notes.
'use strict';

const MAX_NOTE = 2000, MAX_NOTES = 30, MAX_IN_BRIEF = 8000;
const HEADING = 'Notes from sessions on this ticket. A session wrote each note and the person did not approve them. Where a note and the ticket body differ, the body wins.';

const stamp = (at) => (at ? String(at).slice(0, 16).replace('T', ' ') + ' UTC' : 'time not recorded');
const line = (n) => '- ' + n.by + (n.role ? ' (' + n.role + ')' : '') + ', ' + stamp(n.at) + ': ' + String(n.text).replace(/\s*\n\s*/g, ' ');

function briefOf(notes) {
  const list = Array.isArray(notes) ? notes.filter((n) => n && n.text) : [];
  if (!list.length) return '';
  const kept = [];
  let size = 0;
  for (const n of list.slice().reverse()) {
    const l = line(n);
    if (size + l.length > MAX_IN_BRIEF) break;
    kept.unshift(l); size += l.length;
  }
  const left = list.length - kept.length;
  return HEADING + (left ? ' The ' + left + ' oldest ' + (left === 1 ? 'note is' : 'notes are') + ' left out here.' : '') + ' ' + kept.join(' ');
}

const withNotes = (body, notes) => [String(body || '').trim(), briefOf(notes)].filter(Boolean).join('\n\n');

module.exports = { MAX_NOTE, MAX_NOTES, MAX_IN_BRIEF, HEADING, briefOf, withNotes };
