// The relay pushes the Board on the room page's stream (relay/board-push.js): at once when the page
// opens it, again only when the Board changed, and only to a page that asks for it with board=1.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep } = require('./helpers.js');

// Opens the channel's stream and keeps every event it sends, as { type, data }.
function listen(R, query) {
  const ctl = new AbortController(), events = [];
  const done = fetch(R.base + '/stream?key=test-key' + query, { signal: ctl.signal }).then(async (r) => {
    const reader = r.body.getReader(), dec = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) return;
      text += dec.decode(value);
      for (let i; (i = text.indexOf('\n\n')) >= 0; text = text.slice(i + 2)) {
        const m = text.slice(0, i).match(/^event: (\w+)\ndata: (.*)$/);
        if (m) events.push({ type: m[1], data: JSON.parse(m[2]) });
      }
    }
  }).catch(() => {});
  return { events, tickets: () => events.filter((e) => e.type === 'tickets').map((e) => e.data), stop: () => { ctl.abort(); return done; } };
}
async function until(fn, what) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(50); }
  throw new Error('Timed out waiting for ' + what);
}

test('the room page\'s stream gets the Board at once, and again only when it changes', async (t) => {
  const R = await relay();
  t.after(() => R.stop());
  const repo = makeRepo(R.home, 'push-repo');
  const a = (await R.call('POST', '/tickets', { title: 'Pushed first', repo })).body.ticket;
  const page = listen(R, '&board=1'), other = listen(R, '');
  t.after(() => Promise.all([page.stop(), other.stop()]));

  await until(() => page.tickets().length === 1, 'the first push');
  assert.strictEqual(page.events[0].type, 'hello');
  assert.strictEqual(page.events[0].data.tickets, true, 'the hello says the Board comes on this stream');
  const first = page.tickets()[0];
  assert.deepStrictEqual(first.tickets.map((x) => x.id), [a.id]);
  assert.deepStrictEqual(Object.keys((await R.call('GET', '/tickets')).body).sort(), Object.keys(first).filter((k) => k !== 'people').sort(), 'the same Board as GET /tickets');
  assert.ok(Array.isArray(first.people), 'with who sits where, for the names on the cards');

  await sleep(2500);  // two looks at an unchanged Board
  assert.strictEqual(page.tickets().length, 1, 'nothing is sent while nothing changed');

  const b = (await R.call('POST', '/tickets', { title: 'Pushed second', repo })).body.ticket;
  await until(() => page.tickets().length === 2, 'the push after a change');
  assert.deepStrictEqual(page.tickets()[1].tickets.map((x) => x.id), [a.id, b.id]);

  assert.strictEqual(other.events[0].data.tickets, false, 'a page without a Board is told it gets none');
  assert.deepStrictEqual(other.tickets(), [], 'and gets none');
});
