// The ticket store: a JSON file on this computer. To use a real tracker instead, write a module
// with the same shape and start the relay with RELAY_TICKET_STORE=/path/to/it.js.
//
// A store exports open(), which returns an object with these methods. All return promises, since
// a real tracker is across a network. `project` is the relay's channel: map it to whatever the
// tracker calls a project. relay/test/ticket-store-contract.js is the test a store has to pass.
//
//   name                          a short name, shown on the board
//   local                         true if it keeps tickets on this computer. Only then does a deleted chat
//                                 channel leave a summary on its ticket (relay/chat.js).
//   list(project)                 every ticket, oldest first
//   get(project, id)              one ticket, or null
//   create(project, fields)       a new ticket; the store picks its id, which can be any short text
//   update(project, id, changes)  the changed ticket, or null if there is no such ticket
//
// A ticket: { id, title, body, status, priority, repo, base, createdBy, blockedBy: [id], createdAt, updatedAt }
// A store only keeps tickets. The rules about them are in relay/tickets.js, and the checkout and
// worker doing one are in relay/tasks.js, so none of that has to move when the store does.
'use strict';
const fs = require('fs');
const path = require('path');
const state = require('../state.js');
const { claim } = require('../lockfile.js');

function open(options) {
  const file = (options && options.file) || state.file('tickets.json', 'RELAY_TICKETS_FILE');
  const owns = claim(file);
  let data = new Map();
  try { data = new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))); } catch (e) {
    if (e.code !== 'ENOENT') {  // keep a file we cannot read, rather than writing over it
      const aside = file + '.unreadable-' + Date.now();
      try { fs.renameSync(file, aside); console.error('Could not read ' + file + '. Kept it as ' + aside); } catch (e2) { /* nothing to keep */ }
    }
  }
  const projectOf = (p) => { if (!data.has(p)) data.set(p, { next: 1, tickets: [] }); return data.get(p); };
  function save() {
    if (!owns) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(data), null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  const copy = (t) => (t ? JSON.parse(JSON.stringify(t)) : null);
  return {
    name: 'local',
    local: true,
    async list(project) { return projectOf(project).tickets.map(copy); },
    async get(project, id) { return copy(projectOf(project).tickets.find((t) => t.id === id)); },
    async create(project, fields) {
      const p = projectOf(project), at = new Date().toISOString();
      const ticket = Object.assign({}, fields, { id: 'T-' + p.next++, createdAt: at, updatedAt: at });
      p.tickets.push(ticket); save();
      return copy(ticket);
    },
    async update(project, id, changes) {
      const t = projectOf(project).tickets.find((x) => x.id === id);
      if (!t) return null;
      const { id: _id, createdAt: _at, ...rest } = changes;
      Object.assign(t, rest, { updatedAt: new Date().toISOString() }); save();
      return copy(t);
    }
  };
}
module.exports = { open };
