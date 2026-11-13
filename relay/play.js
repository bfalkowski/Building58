#!/usr/bin/env node
// Plays one action in a round of a game, from inside a seat's session (relay/games.js). The seat is
// the session itself: its own token says who it is, so a play never names a seat.
//   node relay/play.js ask "Is this allowed?"
//   node relay/play.js <kind> [text]        any other kind the game's brief names, with optional text
//   node relay/play.js <kind> --json '{"item":"I17","decision":"flag"}'
// It prints the game's answer.
'use strict';

const URL_ = process.env.OFFICE_TICKET_URL, TOKEN = process.env.OFFICE_TICKET_TOKEN;
const [kind, ...rest] = process.argv.slice(2);
if (!kind || !URL_ || !TOKEN) {
  console.error(!kind ? 'Say what to play, for example: node relay/play.js ask "Is this allowed?"' : 'Run this from a seat the room started for a round.');
  process.exit(2);
}
let args;
if (rest[0] === '--json') {
  try { args = JSON.parse(rest[1] || '{}'); } catch (e) { console.error('--json needs a JSON object: ' + e.message); process.exit(2); }
} else args = rest.length ? { text: rest.join(' ') } : {};
// OFFICE_TICKET_URL is the channel's /tickets route. /play is beside it.
const to = URL_.replace(/\/tickets\/?$/, '').replace(/\/$/, '') + '/play';

(async () => {
  let r;
  try {
    r = await fetch(to, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': TOKEN }, body: JSON.stringify({ kind, args }), signal: AbortSignal.timeout(60000) });
  } catch (e) { console.error('The relay did not answer: ' + e.message); process.exit(1); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(body.message || 'The play was refused (' + r.status + ').'); process.exit(1); }
  console.log(typeof body.answer === 'string' ? body.answer : JSON.stringify(body.answer));
})();
