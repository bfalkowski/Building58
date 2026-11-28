// Finds a Dev's claim that its work is already on main, with a commit, in the last thing it said. The
// hook (relay/office-hook.js) sends only the commit, never the words, and relay/nudge.js uses it to tell a
// Dev that has nothing to open from a Dev that is stuck. The claim needs the word main and a hash of 7
// to 40 hex digits with at least one digit and one letter, so a plain word like "deadbeef" or a number
// alone is not one.
'use strict';

const HASH = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i;
const MAIN = /\b(?:origin\/)?main\b/i;

function onMainCommit(text) {
  const said = String(text == null ? '' : text);
  const hash = said.match(HASH);
  return hash && MAIN.test(said) ? hash[0].toLowerCase() : null;
}

const COMMIT = /^[0-9a-f]{7,40}$/;
const heldCommit = (name, ev) => (name === 'Stop' && COMMIT.test(String(ev.on_main)) ? ev.on_main : null);

module.exports = { onMainCommit, heldCommit };
