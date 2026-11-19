// Not a test file of the suite (relay/test/run.js runs only *.test.js). relay/test/room-env.test.js
// runs it through relay/test/run.js to see the names of the room's variables a test file is given.
'use strict';
const test = require('node:test');
test('names the room variables it was given', () => {
  console.log('room variables: [' + Object.keys(process.env).filter((k) => /^(RELAY_|OFFICE_|CLAUDE_CODE_)/.test(k)).sort().join(',') + ']');
});
