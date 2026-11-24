// The PM's check of a ticket before Autopilot starts it (docs/manual/roles.html#pm-trust). Autopilot asks
// consult() on each look at the ticket it would start next. The first ask saves the check brief for the
// newest running PM through relay/delivery.js, so it is typed only when the PM is idle. Each later ask says
// to wait, until the PM answers with ticket.js advise (relay/tickets.js calls answered), or until
// pmCheckMinutes pass, or the PM goes. The check never blocks the room: with no PM, no answer in time, or
// PM trust at Off, the answer is go, and the line in `said` tells why.
'use strict';
const config = require('./config.js');
const terminal = require('./terminal.js');
const delivery = require('./delivery.js');
const trust = require('./pm-trust.js');
const { checkBrief } = require('./pm-check-brief.js');
const CLI = require('path').join(__dirname, 'ticket.js');

const MAX_CHAIN = 3;
const asked = new Map();
const chains = new Map();
const preferred = new Map();
const held = new Map();
const keyOf = (channel, id) => channel + '/' + id;
const deliveryKey = (id) => 'pm-check ' + id;
const limitMs = () => config.get('pmCheckMinutes') * 60 * 1000;
const minutes = () => Math.max(1, Math.round(config.get('pmCheckMinutes') * 10) / 10);

function seat(channel) {
  return terminal.all(channel).filter((t) => t.role === 'pm' && !t.exited && !t.stopped).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0] || null;
}
const give = (channel, id) => {
  asked.delete(keyOf(channel, id));
  delivery.drop(channel, deliveryKey(id));
  if (preferred.get(channel) === id) preferred.delete(channel);
};
const GO = (said) => ({ go: true, said: said || null });

function consult(channel, ticket, all) {
  const rung = trust.level();
  if (rung < trust.ADVISE) {
    for (const other of [...asked.keys()]) if (other.startsWith(channel + '/')) give(channel, other.slice(channel.length + 1));
    return GO();
  }
  const id = ticket.id, key = keyOf(channel, id);
  for (const other of [...asked.keys()]) if (other.startsWith(channel + '/') && other !== key) give(channel, other.slice(channel.length + 1));
  let p = asked.get(key);
  const pm = seat(channel);
  if (p && p.answer) {
    give(channel, id);
    return decide(channel, id, p.answer, rung, all);
  }
  if (!pm) {
    if (p) give(channel, id);
    return GO('No PM is running, so nobody checked ' + id + ' before it started.');
  }
  if (!p) {
    p = { askedAt: Date.now(), answer: null };
    asked.set(key, p);
    delivery.save(channel, { key: deliveryKey(id), terminal: pm.id, sessionId: pm.sessionId, text: checkBrief({ ticket, all, rung, cli: CLI, minutes: minutes() }), expiresAt: p.askedAt + limitMs() });
  }
  const left = p.askedAt + limitMs() - Date.now();
  if (left <= 0) {
    give(channel, id);
    return GO('The PM did not answer the check of ' + id + ' within ' + minutes() + ' ' + (minutes() === 1 ? 'minute' : 'minutes') + ', so it started without it.');
  }
  return { wait: 'Waiting for the PM to check ' + id + ' before it starts: it gives up in ' + Math.ceil(left / 60000) + ' min.' };
}

function decide(channel, id, answer, rung, all) {
  const chain = chains.get(channel) || [];
  if (answer.answer === 'first' && rung >= trust.HOLD) {
    const other = all.find((t) => t.id === answer.of);
    if (!other || other.status !== 'ready' || chain.includes(other.id) || chain.length >= MAX_CHAIN) {
      chains.delete(channel);
      return GO('The PM says ' + answer.of + ' goes first, but it cannot be checked next here, so ' + id + ' started.');
    }
    chains.set(channel, chain.concat(id));
    preferred.set(channel, other.id);
    return { first: other.id, said: 'The PM says ' + other.id + ' goes before ' + id + ': ' + answer.why + ' Autopilot checks ' + other.id + ' next.' };
  }
  chains.delete(channel);
  return GO();
}

const WORDS = { 'not-needed': 'not needed', duplicate: 'a duplicate', 'part-of': 'part of another ticket' };
function answered(channel, id, answer, did) {
  const p = asked.get(keyOf(channel, id));
  if (did === 'advised') { if (p) p.answer = answer; return; }
  if (p) give(channel, id);
  chains.delete(channel);
  const said = 'The PM says ' + id + ' is ' + WORDS[answer.answer] + (answer.of ? ' (' + answer.of + ')' : '') + ': ' + answer.why + ' ' + (did === 'proposed' ? 'It does not start. A proposal waits for the person.' : 'The relay carried it out.');
  (held.get(channel) || held.set(channel, []).get(channel)).push(said);
}
const takeHeld = (channel) => { const said = held.get(channel) || []; held.delete(channel); return said; };
const prefer = (channel) => preferred.get(channel) || null;
const clearPrefer = (channel) => { preferred.delete(channel); };
const waiting = (channel) => [...asked].some(([k, p]) => k.startsWith(channel + '/') && Date.now() - p.askedAt < limitMs());
const forget = () => { asked.clear(); chains.clear(); preferred.clear(); held.clear(); };

module.exports = { consult, answered, takeHeld, prefer, clearPrefer, waiting, seat, forget };
