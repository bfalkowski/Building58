// The manager's seat: the room keeps one manager session running, as it does the PM, and starts it again when it ends.
// It takes one of the three desks kept for the Lead, the PM and the manager (relay/terminal.js), so workers keep six.
// Its token reaches only what the watch and the brake need (relay/token-routes.js). A start that fails is tried
// again after RETRY_MS, with a longer wait each time, up to MAX_WAIT_MS. Nothing starts while the relay closes or an
// update is under way. RELAY_MANAGER_SEAT=0 turns it off. See docs/manual/roles.html#manager-session.
'use strict';
const path = require('path');
const terminal = require('./terminal.js');
const delivery = require('./delivery.js');
const { managerBrief } = require('./manager-brief.js');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(__dirname, 'ticket.js');
const RETRY_MS = Number(process.env.RELAY_MANAGER_SEAT_RETRY_MS) >= 1 ? Number(process.env.RELAY_MANAGER_SEAT_RETRY_MS) : 5000;
const MAX_WAIT_MS = 60 * 1000;
const tries = new Map();
const timers = new Map();
const starting = new Set();
let ctxOf = null;
const on = () => terminal.ENABLED && process.env.RELAY_MANAGER_SEAT !== '0';
const sits = (channel) => terminal.all(channel).some((t) => t.role === 'manager');

function later(channel) {
  if (timers.has(channel)) return;
  const t = setTimeout(() => { timers.delete(channel); ensure(channel); }, Math.min(MAX_WAIT_MS, RETRY_MS * 2 ** (tries.get(channel) || 0)));
  t.unref();
  timers.set(channel, t);
}
function ensure(channel) {
  if (!on() || !ctxOf || timers.has(channel) || starting.has(channel) || terminal.isClosing()) return;
  if (terminal.isUpdating()) { later(channel); return; }
  if (sits(channel)) { tries.delete(channel); return; }
  starting.add(channel);
  try {
    const r = terminal.start(channel, { cwd: ROOT, title: 'Manager', role: 'manager' }, ctxOf);
    if (r.status < 400) {
      ctxOf.log('Started the manager on ' + channel + '.');
      delivery.promptOnce(channel, r.body.id, managerBrief({ cli: CLI, skills: require('./rules.js').brief() }), (problem) => { if (problem) ctxOf.log('The manager was not briefed: ' + problem); });
      return;
    }
    tries.set(channel, (tries.get(channel) || 0) + 1);
    ctxOf.log('Could not start the manager on ' + channel + ': ' + ((r.body && r.body.message) || 'unknown') + ' It tries again.');
    later(channel);
  } finally { starting.delete(channel); }
}
function begin(channel, ctx) {
  if (!on() || !channel) return;
  ctxOf = ctx;
  terminal.onEnd((ch, t, code, closing) => {
    if (closing || t.role !== 'manager' || ch !== channel) return;
    ctx.log('The manager on ' + channel + ' ended. It starts again.');
    later(channel);
  });
  ensure(channel);
}

module.exports = { begin, ensure };
