// What the room keeps of a Dev's claim that its work is already on main, with a commit. The hook
// (relay/office-hook.js, onMainCommit) finds the claim in the Dev's last words and sends only the commit,
// never the words. It lives in the hook because the hook is installed as one file. The room keeps the
// commit from a Stop only, when it is 7 to 40 hex digits, and relay/nudge.js reads it.
'use strict';

const COMMIT = /^[0-9a-f]{7,40}$/;
const heldCommit = (name, ev) => (name === 'Stop' && COMMIT.test(String(ev.on_main)) ? ev.on_main : null);

module.exports = { heldCommit };
