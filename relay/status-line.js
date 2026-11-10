// The status line of a session the room starts (relay/terminal.js passes it in --settings). Claude
// Code runs it after each change in the session and hands it JSON on stdin. It prints how tired the
// session is, how much of its context window it has used, by the levels in relay/lead-tired.js:
//   ◑ context 62% · getting tired
// Then it sends the number to the relay with the session's own token, so the Floor and ticket.js
// show the same level. Like the hook, it gives up on the relay after one second, prints even when the
// relay is away, and always exits 0.
'use strict';
const tired = require('./lead-tired.js');

function line(input) {
  const level = tired.levelOf(tired.percentOf(input));
  return level ? level.icon + ' context ' + tired.percentOf(input) + '% · ' + level.label : 'context: no reply yet';
}

// POST /channels/{channel}/terminals/context, beside the /commands the hook sends to.
async function send(input) {
  const url = process.env.OFFICE_HOOK_URL, token = process.env.OFFICE_TICKET_TOKEN;
  const reading = tired.readingOf(input, Date.now());
  if (!url || !token || !reading || !/\/commands$/.test(url)) return;
  try {
    await fetch(url.replace(/\/commands$/, '/terminals/context'), {
      method: 'POST', signal: AbortSignal.timeout(1000),
      headers: { 'Content-Type': 'application/json', 'X-Office-Token': token },
      body: JSON.stringify({ session_id: reading.sessionId, percent: reading.percent, size: reading.size }),
    });
  } catch (e) { /* the relay is away: the line is printed already */ }
}

function main() {
  const hardStop = setTimeout(() => process.exit(0), 1500);
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; if (raw.length > 1e6) raw = raw.slice(0, 1e6); });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    let input = null;
    try { input = JSON.parse(raw); } catch (e) { /* not JSON: print what is known */ }
    process.stdout.write(line(input) + '\n');
    send(input).finally(() => { clearTimeout(hardStop); process.exit(0); });
  });
}

if (require.main === module) main();
else module.exports = { line };
