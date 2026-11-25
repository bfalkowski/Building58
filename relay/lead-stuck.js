// The Lead's stuck items (T-465). While the person has turned on Let the Lead unstick the board, the Lead names each
// stuck item it sees on a pass with ticket.js stuck <PR or ticket> --why 'what it saw', and acts on it. The relay
// counts how many passes in a row named the same item with no action. A pass counts when it comes at least
// PASS_MS after the last one counted. On the third, the item goes on Needs you with the Lead's reason, and the jam
// log gets a jam passed to the person. An item the Lead acts on (a jam written with by: Lead and the same PR or
// ticket) is cleared: its jam carries since, the time it was first seen. An item the Lead stops naming for
// GONE_MS leaves the list, and if it was never acted on and never passed on, the jam log gets a jam seen and never
// acted on. The Metrics page's Lead section counts those (relay/metrics-plan.js). The list is kept in memory, so
// a restart empties it. See docs/manual/roles.html#unstick.
'use strict';
const config = require('./config.js');
const terminal = require('./terminal.js');
const jams = require('./jams.js');
const { oneLine } = require('./clean.js');
const { JAM_KINDS } = require('./metrics-plan.js');

const PASS_MS = Number(process.env.RELAY_STUCK_PASS_MS) >= 0 && process.env.RELAY_STUCK_PASS_MS !== undefined ? Number(process.env.RELAY_STUCK_PASS_MS) : 2 * 60 * 1000;
const GONE_MS = 60 * 60 * 1000;
const PASSES = 3;
const MAX_ITEMS = 100;
const store = new Map();
const items = (channel) => store.get(channel) || store.set(channel, new Map()).get(channel);

function report(channel, body) {
  const b = body && typeof body === 'object' ? body : {};
  const item = oneLine(b.item, 120), why = oneLine(b.why, 300), kind = Object.hasOwn(JAM_KINDS, b.kind) ? b.kind : 'other';
  if (!item) return [400, { ok: false, error: 'bad_param', message: '"item" names the stuck PR or ticket.' }];
  if (!why) return [400, { ok: false, error: 'bad_param', message: '"why" says what you saw, or why you cannot act.' }];
  const list = items(channel), now = Date.now();
  let x = list.get(item);
  if (!x) {
    if (list.size >= MAX_ITEMS) return [409, { ok: false, error: 'full', message: 'The list holds ' + MAX_ITEMS + ' stuck items. Act on some first.' }];
    x = { item, kind, why, first: now, last: now, counted: now, passes: 1, passed: false };
    list.set(item, x);
  } else {
    Object.assign(x, { kind, why, last: now });
    if (now - x.counted >= PASS_MS) { x.passes++; x.counted = now; }
  }
  if (x.passes >= PASSES && !x.passed) {
    x.passed = true;
    jams.record(channel, { kind: x.kind, fix: oneLine('Passed to the person: ' + oneLine(x.why, 120), 200), by: 'Lead', outcome: 'passed', since: new Date(x.first).toISOString(), ticket: idLike(item), pr: prLike(item) });
  }
  const message = x.passed ? item + ' is on Needs you: you named it ' + x.passes + ' passes in a row and did not act. Do not name it again unless something changes. Reason shown to the person: ' + x.why
    : item + ' named on ' + x.passes + ' of ' + PASSES + ' passes. Act on it now. If you cannot, say exactly why in --why: on the ' + PASSES + 'rd pass the person sees it.';
  return [200, { ok: true, item, passes: x.passes, onNeedsYou: x.passed, message }];
}
const idLike = (item) => (/^[\w.:/#-]{1,300}$/.test(item) && !/^https?:/.test(item) ? item : undefined);
const prLike = (item) => (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(item) ? item : undefined);

function acted(channel, jam) {
  const list = items(channel);
  const number = jam.pr && (String(jam.pr).match(/\/pull\/(\d+)$/) || [])[1];
  for (const [item, x] of list) {
    if (item === jam.pr || item === jam.ticket || (number && (item === '#' + number || item === 'PR #' + number))) { list.delete(item); return x; }
  }
  return null;
}
const firstSeen = (channel, jam) => {
  const list = items(channel), number = jam.pr && (String(jam.pr).match(/\/pull\/(\d+)$/) || [])[1];
  for (const [item, x] of list) if (item === jam.pr || item === jam.ticket || (number && (item === '#' + number || item === 'PR #' + number))) return x.first;
  return null;
};

function sweep() {
  const now = Date.now();
  for (const [channel, list] of store) {
    for (const [item, x] of list) {
      if (now - x.last < GONE_MS) continue;
      list.delete(item);
      if (!x.passed) jams.record(channel, { kind: x.kind, fix: oneLine('Seen and never acted on: ' + oneLine(x.why, 120), 200), by: 'Lead', outcome: 'seen', since: new Date(x.first).toISOString(), ticket: idLike(item), pr: prLike(item) });
    }
  }
}
const passedOf = (channel) => [...items(channel).values()].filter((x) => x.passed).map((x) => ({ item: x.item, why: x.why, passes: x.passes, kind: x.kind }));

async function handle(req, res, channel, rest, ctx) {
  if (rest !== '/stuck') return false;
  const deny = terminal.localOnly(req, ctx.port);
  if (deny) { ctx.problem(res, 403, 'local_only', deny); return true; }
  if (req.method !== 'POST') { ctx.problem(res, 404, 'not_found', 'Stuck answers POST only.'); return true; }
  if (ctx.agent && !ctx.agent.lead) { ctx.problem(res, 403, 'forbidden', 'Only the Lead names stuck items.'); return true; }
  if (!config.get('leadUnstick')) { ctx.problem(res, 403, 'forbidden', require('./failures.js').NOT_ON); return true; }
  const out = report(channel, await ctx.readJson(req));
  ctx.send(res, out[0], out[1]);
  return true;
}
function begin() { setInterval(sweep, 60 * 1000).unref(); }

module.exports = { handle, report, acted, firstSeen, passedOf, sweep, begin, PASSES };
