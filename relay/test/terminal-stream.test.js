// A page that opens a session's stream gets each piece of output once, even when it opens while the
// relay is still holding the newest output for its next batch.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { relay, sleep, until } = require('./helpers.js');

test('output that is waiting for its batch when a page opens the stream is shown once', async (t) => {
  const R = await relay({ RELAY_OUT_BATCH_MS: '600' });  // the batch is about 16 ms, too short to open a stream inside it on purpose
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const a = (await R.call('POST', '/terminals', { cwd: R.home })).body;
  await until(async () => (await R.screen(a.id)).includes('❯'), 'the prompt');
  await sleep(1000);  // every batch so far has gone out
  await R.call('POST', '/terminals/' + a.id + '/input', { data: 'mark-once\r' });
  await sleep(200);   // the fake has echoed it, and the relay holds that for its batch
  const seen = await R.screen(a.id, 1200);  // open now, and read until well after the batch goes out
  assert.strictEqual(seen.split('GOT[mark-once]').length - 1, 1, seen);
});

test('a page watching when a session ends gets its last output before the end', async (t) => {
  const R = await relay({ RELAY_OUT_BATCH_MS: '600' });  // longer than the 30 ms before the relay says a session has ended
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const a = (await R.call('POST', '/terminals', { cwd: R.home })).body;
  await until(async () => (await R.screen(a.id)).includes('❯'), 'the prompt');
  await sleep(1000);
  const ctl = new AbortController();
  const r = await fetch(R.base + '/terminals/' + a.id + '/stream', { headers: { Authorization: 'Bearer test-key' }, signal: ctl.signal });
  const reader = r.body.getReader(), dec = new TextDecoder();
  const events = [];  // what the page gets, in order, until the end
  const reading = (async () => {
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += dec.decode(value);
      for (let i; (i = text.indexOf('\n\n')) >= 0; text = text.slice(i + 2)) {
        const m = text.slice(0, i).match(/^event: (\w+)\ndata: (.*)$/);
        if (m) events.push(m[1] === 'out' ? Buffer.from(JSON.parse(m[2]), 'base64').toString() : m[1]);
      }
      if (events.includes('exit')) return;
    }
  })();
  await sleep(200);  // the replay is in
  await R.call('POST', '/terminals/' + a.id + '/input', { data: '/exit\r' });
  await Promise.race([reading, sleep(3000)]);
  ctl.abort();
  const end = events.indexOf('exit');
  assert.ok(end >= 0, 'the page is told the session ended');
  assert.ok(events.slice(0, end).join('').includes('GOT[/exit]'), 'the last output comes first: ' + JSON.stringify(events.slice(1)).slice(-300));
});
