// What npm run office prints about the hooks when it leaves the room running.
// The hooks in ~/.claude/settings.json serve one room, the default one: port 8787 and the state
// folder ~/.office-world. A second room (another port or RELAY_STATE_DIR) gets no install line,
// since installing would take the hooks away from the first. The key is never printed.
'use strict';
const os = require('os');
const path = require('path');

const DEFAULT_PORT = '8787';
const DEFAULT_DIR = path.join(os.homedir(), '.office-world');

function isDefaultOffice(relayUrl, stateDir) {
  let u;
  try { u = new URL(relayUrl); } catch (e) { return false; }
  return ['localhost', '127.0.0.1'].includes(u.hostname) && (u.port || '80') === DEFAULT_PORT && stateDir === DEFAULT_DIR;
}

// relayUrl: the relay's address. stateDir: the relay's state folder, as relay/state.js resolves it.
function hookHint(relayUrl, stateDir, channel) {
  if (!isDefaultOffice(relayUrl, stateDir)) {
    return 'This is a second room. The sessions it starts report here on their own. Do not install\n' +
      'the hooks for it: that would take them away from the first room. See "A second room" in\n' +
      'docs/manual/running.html.';
  }
  const pick = channel && channel !== 'office' ? " --channel '" + String(channel).replace(/'/g, "'\\''") + "'" : '';
  return 'To send sessions from your own terminal here too, add the hooks once:\n  OFFICE_RELAY_KEY=<your relay key> node relay/office-hook.js --install' + pick;
}

module.exports = { hookHint, isDefaultOffice };
