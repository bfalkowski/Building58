// The one place that decides something is stuck, and which kind (467). A detector (Autopilot's hand-over,
// the PR watch's late PR, the main CI check, a session the relay could not type into) calls raise() with
// a kind from the jam kinds (relay/metrics-plan.js) and an id for the thing that is stuck. The same id is
// kept once, whoever raises it again, with the owner that the kind has: Autopilot for the mechanical kinds,
// the Lead for those that need judgment, the person for what only the person can do. The Lead reads this
// list (relay/lead-check.js) and is woken when a new item has the Lead or the person as owner.
// See docs/manual/how-it-works.html#stuck.
'use strict';
const { EventEmitter } = require('events');
const { oneLine } = require('./clean.js');
const { JAM_KINDS } = require('./metrics-plan.js');

const OWNERS = {
  'no-first-review': 'autopilot', 'desks-full': 'autopilot', 'news-untold': 'autopilot', 'merged-not-done': 'autopilot', 'no-new-commit': 'autopilot', 'stale-cache': 'autopilot',
  'waits-on-state': 'lead', 'dev-idle': 'lead', 'main-red': 'lead', 'tunnel-down': 'lead', 'push-refused': 'lead', 'stuck-job': 'lead', 'news-behind-menu': 'lead', 'dev-asks': 'lead', 'not-needed': 'lead', 'handover-starts-new': 'lead', 'flake-blocks': 'lead', 'push-hold-red-ci': 'lead', 'update-waits': 'lead', other: 'lead',
  'handed-over': 'person', 'person-merge': 'person', 'signing-key': 'person', 'workflows-push': 'person', 'out-of-rounds': 'person', 'permission-prompt': 'person',
};
const events = new EventEmitter();
const open = new Map();
const of = (channel) => open.get(channel) || open.set(channel, new Map()).get(channel);

function raise(channel, { kind, id, text, since }) {
  const items = of(channel), have = items.get(id);
  if (have) return { item: have, fresh: false };
  const k = Object.hasOwn(JAM_KINDS, kind) ? kind : 'other';
  const item = { id: oneLine(id, 200), kind: k, owner: OWNERS[k] || 'lead', text: oneLine(text, 300), since: new Date(since || Date.now()).toISOString(), told: false };
  items.set(id, item);
  events.emit('raised', channel, item);
  return { item, fresh: true };
}
function clear(channel, id) { return of(channel).delete(id); }
const list = (channel) => [...of(channel).values()];
const toTell = (channel) => list(channel).filter((i) => i.owner !== 'autopilot' && !i.told);
function told(channel, items) { for (const i of items) i.told = true; }
function untold(channel) { for (const i of list(channel)) i.told = false; }
function reset() { open.clear(); }

function begin() {
  require('./delivery.js').onStuck((channel, t) => raise(channel, { kind: 'dev-idle', id: 'session ' + t.id, text: (t.name || 'A session') + ' is stuck: ' + ((t.stuck && t.stuck.why) || 'it did not take a message') + '.', since: t.stuck && t.stuck.at }));
  require('./terminal.js').onEnd((channel, t) => clear(channel, 'session ' + t.id));
  require('./tasks.js').events.on('state', (channel, task) => { if (task.pr && (task.state === 'done' || task.state === 'building')) clear(channel, 'pr ' + task.pr); });
}

module.exports = { begin, raise, clear, list, toTell, told, untold, reset, events, OWNERS };
