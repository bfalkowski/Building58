// The slot gate: loaded into every node process of a session the room starts, through NODE_OPTIONS
// (relay/session-env.js slotGate). In the process of one test file of a node --test run, in any repo,
// it takes one of the shared test slots (relay/test/slots.js) before the file loads, and holds it
// until the process ends. So the test files of every repo a room works in share one pool with
// Building58's own npm test, and the computer runs no more of them at once than it has cores. Every
// other process passes through at once. Once it holds a slot it sets TEST_SLOTS=0, so a test run
// that the file starts does not wait behind the slot its own parent holds.
'use strict';
const { slots, sizeOf, DIR } = require('./slots.js');

const size = sizeOf(process.env.TEST_SLOTS);
if (String(process.env.NODE_TEST_CONTEXT || '').startsWith('child') && size) {
  const pool = slots({ dir: process.env.TEST_SLOTS_DIR || DIR, size });
  pool.takeSync(() => process.stderr.write('# waiting for a test slot: other test runs on this computer hold all ' + size + ' slots (TEST_SLOTS). The slots are files in ' + (process.env.TEST_SLOTS_DIR || DIR) + '\n'));
  process.env.TEST_SLOTS = '0';
}
