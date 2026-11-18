// Not a test file of the suite (relay/test/run.js runs only *.test.js). relay/test/test-cleanup.test.js
// runs it to show a file that ends while a process it started still holds its output fails at once.
// Its test passes and the file ends, but it leaves a child in a process group of its own, as the
// session host is, that keeps the file's output open after the file has ended.
'use strict';
const fs = require('fs');
const test = require('node:test');
const { spawn } = require('child_process');
test('leaves a child of its own group holding the output', () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', detached: true });
  child.unref();
  if (process.env.HANG_PID_FILE) fs.writeFileSync(process.env.HANG_PID_FILE, String(child.pid));
});
