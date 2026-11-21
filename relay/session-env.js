// The environment the relay gives each Claude Code session it starts (relay/terminal.js), and the same
// thing as names only, for the security officer (relay/access.js). One list, so the report says what
// the sessions really get.
//
// A session gets the relay's own environment, which is the person's, with these taken out:
//   the relay's key and settings, so a session cannot act as the relay or as the person's room page
//   the variables of a Claude Code session that started the relay. A child session saves no
//   conversation, so it could never be brought back.
// and the room's own variables added: its desk, channel, ticket token and where to send its hooks, and
// for a seat in a round of a game, OFFICE_SEAT and OFFICE_PLAY (relay/games.js).
//
// slotGate adds the test slot gate (relay/test/slot-gate.js) to NODE_OPTIONS, after what the person
// set there, unless TEST_SLOTS is 0. NODE_OPTIONS names a stub in the room's state folder, and the stub
// loads the gate only if it is still there, since a session can outlive the code that started it, as
// after a rollback, and node does not start when NODE_OPTIONS names a file that is gone.
'use strict';
const fs = require('fs');
const path = require('path');

const GATE = path.join(__dirname, 'test', 'slot-gate.js');

const RELAY = ['RELAY_KEY', 'OFFICE_RELAY_KEY', 'RELAY_TERMINAL', 'RELAY_KEY_RANDOM',
  'RELAY_WORKER', 'RELAY_SUPERVISED', 'RELAY_HOST_SOCKET'];
const INHERITED = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN'];
const REMOVED = RELAY.concat(INHERITED);
const ADDED = ['NODE_OPTIONS', 'OFFICE_CHANNEL', 'OFFICE_HOOK_URL', 'OFFICE_PANEL_CHANNEL', 'OFFICE_PLAY', 'OFFICE_SEAT', 'OFFICE_TERMINAL_ID', 'OFFICE_TICKET_TOKEN', 'OFFICE_TICKET_URL'];
const LOGIN_LIKE = /TOKEN|SECRET|PASSW|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|_AUTH|AUTH_|SESSION_?KEY|_PAT$/i;

function build(base, set) {
  const env = Object.assign({}, base);
  for (const name of REMOVED) delete env[name];
  return Object.assign(env, set);
}

function slotGate(base, stateDir) {
  if (String(base.TEST_SLOTS) === '0') return {};
  const stub = path.join(stateDir, 'slot-gate.js');
  const code = "'use strict';\ntry { require(" + JSON.stringify(GATE) + "); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }\n";
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stub + '.tmp', code);
  fs.renameSync(stub + '.tmp', stub);
  return { NODE_OPTIONS: [base.NODE_OPTIONS, '--require=' + JSON.stringify(stub)].filter(Boolean).join(' ') };
}

function names(base) {
  const has = Object.keys(base || {});
  const passedOn = has.filter((n) => !REMOVED.includes(n) && !ADDED.includes(n)).sort();
  return {
    removed: has.filter((n) => REMOVED.includes(n)).sort(),
    added: ADDED.slice(),
    passedOn,
    loginLike: passedOn.filter((n) => LOGIN_LIKE.test(n))
  };
}

module.exports = { build, names, slotGate, REMOVED, ADDED, LOGIN_LIKE };
