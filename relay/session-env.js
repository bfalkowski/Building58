// The environment the relay gives each Claude Code session it starts (relay/terminal.js), and the same
// thing as names only, for the security officer (relay/access.js). One list, so the report says what
// the sessions really get.
//
// A session gets the relay's own environment, which is the person's, with these taken out:
//   the relay's key and settings, so a session cannot act as the relay or as the person's room page
//   the variables of a Claude Code session that started the relay. A child session saves no
//   conversation, so it could never be brought back.
// and the room's own variables added: its desk, channel, ticket token and where to send its hooks.
'use strict';

const RELAY = ['RELAY_KEY', 'OFFICE_RELAY_KEY', 'RELAY_TERMINAL', 'RELAY_KEY_RANDOM',
  'RELAY_WORKER', 'RELAY_SUPERVISED', 'RELAY_HOST_SOCKET'];  // a relay a session starts gets its own supervisor and host
const INHERITED = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN'];
const REMOVED = RELAY.concat(INHERITED);
const ADDED = ['OFFICE_CHANNEL', 'OFFICE_HOOK_URL', 'OFFICE_PANEL_CHANNEL', 'OFFICE_TERMINAL_ID', 'OFFICE_TICKET_TOKEN', 'OFFICE_TICKET_URL'];
// A name that looks like it holds a login, a key or a password. It is a guess from the name alone.
const LOGIN_LIKE = /TOKEN|SECRET|PASSW|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|_AUTH|AUTH_|SESSION_?KEY|_PAT$/i;

// The environment for a new session: base without what is removed, with set added.
function build(base, set) {
  const env = Object.assign({}, base);
  for (const name of REMOVED) delete env[name];
  return Object.assign(env, set);
}

// The same, by name only: never a value. passedOn is what a session inherits from base.
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

module.exports = { build, names, REMOVED, ADDED };
