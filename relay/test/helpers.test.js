// The test helpers themselves, where a busy machine once broke them (T-154).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { relay } = require('./helpers.js');

// The relay closes a kept-alive connection after 5 idle seconds. A test that blocks for longer, as a few
// execFileSync calls do on a busy machine, cannot see that close, and its next request used to fail
// with "fetch failed" (ECONNRESET).
test('a request after the test was blocked longer than the relay keeps a connection still gets its answer', async (t) => {
  const R = await relay(); t.after(R.stop);
  assert.strictEqual((await R.call('GET', '/terminals')).status, 200);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);
  assert.strictEqual((await R.call('GET', '/terminals')).status, 200);
});
