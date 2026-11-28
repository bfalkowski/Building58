// A task's PR gets the label kind:<kind> of its ticket when the relay links the PR, with the GitHub ticket
// store, so a search such as label:kind:bug finds fix PRs. See docs/manual/running.html.
// The relay only adds the label. A ticket with no kind adds none, and no label is taken off.
'use strict';
const door = require('./gh.js');
const tasks = require('./tasks.js');
const { oneLine } = require('./clean.js');

const PREFIX = 'kind:';
const COLOR = 'c5def5';
const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/\d+$/;

async function label(pr, name) {
  const [, owner, repo] = pr.match(PR_URL);
  const edit = () => door.exec(['pr', 'edit', pr, '--add-label', name], {});
  let r = await edit();
  if (r.err && /not found/i.test(String(r.stderr))) {
    const made = await door.exec(['label', 'create', name, '--repo', owner + '/' + repo, '--color', COLOR, '--description', 'Kept by the room relay'], {});
    if (made.err && !/already exists/i.test(String(made.stderr))) return made;
    r = await edit();
  }
  return r;
}

async function onPr(channel, task, tickets) {
  if (!task.ticket || !PR_URL.test(task.pr || '') || tickets.storeName !== 'github') return;
  try {
    const ticket = (await tickets.listAll(channel)).find((t) => t.id === task.ticket);
    if (!ticket || typeof ticket.kind !== 'string' || !ticket.kind) return;
    const r = await label(task.pr, PREFIX + ticket.kind);
    if (r.err) console.error('Could not label ' + task.pr + ' with ' + PREFIX + ticket.kind + ': ' + oneLine(r.stderr || r.err.message, 200));
  } catch (e) { console.error('Could not read the kind of ' + task.ticket + ': ' + oneLine(e.message, 200)); }
}

function begin(tickets) {
  tasks.events.on('pr', (channel, task) => { onPr(channel, task, tickets); });
}

module.exports = { begin, onPr };
