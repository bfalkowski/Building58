// The PM's seat: the room keeps one PM running, as it does the Lead, and starts it again when it ends.
// It takes one of the three desks kept for the Lead, the PM and the manager (relay/terminal.js), so workers keep six.
// A start that fails is tried again after RETRY_MS, with a longer wait each time, up to MAX_WAIT_MS.
// A seat that ends within STABLE_MS of starting counts as a failed try. The count clears only after one ran that long.
// Nothing starts while the relay closes or an update is under way. RELAY_PM_SEAT=0 turns it off.
'use strict';
const terminal = require('./terminal.js');

const RETRY_MS = Number(process.env.RELAY_PM_SEAT_RETRY_MS) >= 1 ? Number(process.env.RELAY_PM_SEAT_RETRY_MS) : 5000;
const MAX_WAIT_MS = 60 * 1000;
const STABLE_MS = Number(process.env.RELAY_PM_SEAT_STABLE_MS) >= 1 ? Number(process.env.RELAY_PM_SEAT_STABLE_MS) : 30 * 1000;
const startedAt = new Map();
const tries = new Map();
const timers = new Map();
const starting = new Set();
let ctxOf = null;
const on = () => terminal.ENABLED && process.env.RELAY_PM_SEAT !== '0';

function later(channel) {
  if (timers.has(channel)) return;
  const n = tries.get(channel) || 0;
  const t = setTimeout(() => { timers.delete(channel); ensure(channel); }, Math.min(MAX_WAIT_MS, RETRY_MS * 2 ** n));
  t.unref();
  timers.set(channel, t);
}
async function ensure(channel) {
  if (!on() || !ctxOf || timers.has(channel) || starting.has(channel) || terminal.isClosing()) return;
  if (terminal.isUpdating()) { later(channel); return; }
  if (terminal.all(channel).some((t) => t.standing)) return;
  starting.add(channel);
  let r;
  try { r = await require('./tickets.js').seatPm(channel, process.cwd(), ctxOf); } catch (e) { r = [500, { message: e.message }]; } finally { starting.delete(channel); }
  if (r[0] < 400) { startedAt.set(channel, Date.now()); ctxOf.log('Started the PM on ' + channel + '.'); return; }
  tries.set(channel, (tries.get(channel) || 0) + 1);
  ctxOf.log('Could not start the PM on ' + channel + ': ' + ((r[1] && r[1].message) || 'unknown') + ' It tries again.');
  later(channel);
}
function begin(channel, ctx) {
  if (!on() || !channel) return;
  ctxOf = ctx;
  terminal.onEnd((ch, t, code, closing) => {
    if (closing || !t.standing || ch !== channel) return;
    const ran = Date.now() - (startedAt.get(channel) || 0);
    startedAt.delete(channel);
    if (ran < STABLE_MS) tries.set(channel, (tries.get(channel) || 0) + 1); else tries.delete(channel);
    ctx.log('The PM on ' + channel + ' ended. It starts again.');
    later(channel);
  });
  ensure(channel);
}

module.exports = { begin, ensure };
