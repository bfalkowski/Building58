// Not a test file of the suite (relay/test/run.js runs only *.test.js). relay/test/test-cleanup.test.js
// runs it to show a file that never ends is stopped. Its test passes, but it leaves a child running
// that holds the output open, as a relay that no cleanup stopped does, so the file never ends.
'use strict';
const fs = require('fs');
const test = require('node:test');
const { spawn } = require('child_process');
test('leaves a child running', () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
  if (process.env.HANG_PID_FILE) fs.writeFileSync(process.env.HANG_PID_FILE, String(child.pid));
});
