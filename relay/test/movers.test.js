// The baked look (office/look.js) bakes every solid part that does not move, and hides the live copy.
// A part that moves but is missing from the movers list in office/office.js stays shut or still in the
// baked look. This test finds each group the room code turns or moves after it is built, and checks
// that the movers list names it.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'office', 'office.js'), 'utf8');
const lines = source.split('\n');

function movedGroups() {
  const names = [...source.matchAll(/^ {2}const (\w+) = new THREE\.Group\(\)/gm)].map((m) => m[1]);
  return names.filter((name) => {
    const moves = new RegExp('\\b' + name + '\\.(rotation|position|scale)\\.[xyz] *(\\+|-)?= ');
    return lines.some((l) => moves.test(l) && !l.includes('const ' + name + ' = '));
  });
}

test('every group the room turns or moves is on the movers list the baked look gets', () => {
  const list = lines.find((l) => /^\s*movers: \(\) =>/.test(l));
  assert.ok(list, 'the movers list is in office.js');
  const moved = movedGroups();
  assert.ok(moved.includes('door') && moved.includes('fridgeDoor'), 'the scan finds the doors: ' + moved);
  for (const name of moved) assert.match(list, new RegExp('[\\s,\\[]' + name + '[\\s,\\]]'), name + ' moves, so it must be on the movers list');
});
