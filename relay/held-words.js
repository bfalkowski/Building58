// What holds a PR's review, in words: "held: check browser failed". Plain, so Autopilot's reason and the Floor say it
// the same way (relay/autopilot-plan.js, relay/desk.js). See docs/manual/roles.html#flake-rerun.
'use strict';

function heldBy(names) {
  const list = [...new Set((names || []).map((n) => String(n || '').trim()).filter(Boolean))];
  if (!list.length) return null;
  if (list.length === 1) return 'held: check ' + list[0] + ' failed';
  return 'held: checks ' + list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1] + ' failed';
}

module.exports = { heldBy };
