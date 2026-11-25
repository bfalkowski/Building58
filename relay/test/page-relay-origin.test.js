// The room page talks only to the relay that served it: ?relay= in the address changes nothing.
// See docs/manual/relay.html#page-origin.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'relay.js'), 'utf8');

function load(search) {
  const streams = [];
  class EventSource {
    constructor(u) { this.url = u; streams.push(u); }
    addEventListener() {}
  }
  const timers = [];
  const sandbox = {
    URLSearchParams,
    location: { search, origin: 'http://127.0.0.1:41054' },
    document: { getElementById: () => null, addEventListener() {}, hidden: false },
    window: {
      run: { events: () => [], on() {}, do: async () => ({ ok: true }) },
      EventSource,
      dispatchEvent() {},
    },
    EventSource,
    CustomEvent: class {},
    fetch: async () => ({ status: 200 }),
    setInterval: (f) => { timers.push(f); return 0; },
    encodeURIComponent,
  };
  vm.runInNewContext(source, sandbox);
  return streams;
}

test('The page ignores ?relay= and uses its own origin', () => {
  const own = load('?channel=room');
  const foreign = load('?channel=room&relay=https://other.example');
  assert.deepStrictEqual(own, ['http://127.0.0.1:41054/channels/room/stream']);
  assert.deepStrictEqual(foreign, own);
});
