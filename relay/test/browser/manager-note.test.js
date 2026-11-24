// The manager's notes on the room page (office/manager-watch.js, the managerNote action): a note goes in Activity,
// he comes out of his office, walks to the desk it is about and says it in his bubble in plain words, and with no
// desk to go to he says it at the board. Then he goes back to his desk.
'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { office, pageTest, until } = require('./page.js');
const { makeRepo, until: waitFor } = require('../helpers.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;
const SAY = 'T-12 has not moved in 70 minutes.';

pageTest('a note puts a line in Activity, and he says it at the desk it is about', get, async (p) => {
  const repo = makeRepo(o.R.home, 'note-repo');
  const session = (await o.R.call('POST', '/terminals', { cwd: repo })).body;
  await p.open();
  await p.page.evaluate(() => window.run.ready());
  const who = await waitFor(() => p.page.evaluate((id) => (window.run.state().workers.find((w) => w.session && w.session.terminal === id) || {}).id, session.id), 'the session at a desk');
  await p.page.evaluate(() => window.run.do({ action: 'speed', value: 8 }));
  const r = await p.page.evaluate((a) => window.run.do(a), { action: 'managerNote', text: 'T-12 is in Building, and no hook, push or PR change came for 70 minutes.', say: SAY, terminal: session.id, ticket: 'T-12' });
  assert.strictEqual(r.ok, true);
  await until(p, () => [...document.querySelectorAll('#feed li')].some((li) => li.textContent.includes('The manager: T-12 is in Building, and no hook, push or PR change came for 70 minutes.')));
  await until(p, () => window.run.state().managerHere);
  await until(p, (line) => [...document.querySelectorAll('.bubble')].some((b) => !b.hidden && b.textContent === line), SAY);
  const [boss, desk] = await p.page.evaluate((id) => [window.run.debug('manager'), window.run.debug(id)], who);
  assert.match(boss.spot, /^boss-behind-/, 'he stands behind a desk');
  assert.ok(Math.hypot(boss.pos[0] - desk.pos[0], boss.pos[1] - desk.pos[1]) < 1.6, 'behind the desk the note is about: ' + boss.pos + ' and ' + desk.pos);
  await until(p, () => !window.run.state().managerHere);
  await until(p, () => { const d = window.run.debug('manager'); return d.seated && d.spot === 'boss-desk'; });
  assert.deepStrictEqual(p.errors, []);
});

pageTest('a note about no desk is said at the board, and a note with no words is refused', get, async (p) => {
  await p.open();
  await p.page.evaluate(() => window.run.ready());
  await p.page.evaluate(() => window.run.do({ action: 'speed', value: 8 }));
  const bad = await p.page.evaluate(() => window.run.do({ action: 'managerNote', text: '  ' }));
  assert.strictEqual(bad.ok, false);
  await p.page.evaluate((say) => window.run.do({ action: 'managerNote', text: 'Autopilot handed 3 tasks in a row to Waiting on you: T-1, T-2, T-3.', say }), 'Autopilot has given 3 tasks in a row to you.');
  await until(p, () => window.run.debug('manager').spot === 'boss-board');
  await until(p, () => [...document.querySelectorAll('.bubble')].some((b) => !b.hidden && b.textContent === 'Autopilot has given 3 tasks in a row to you.'));
  await until(p, () => { const d = window.run.debug('manager'); return d.seated && d.spot === 'boss-desk'; });
  assert.deepStrictEqual(p.errors, []);
});

pageTest('the page reads the relay\'s notes, once each, and not the old ones', get, async (p) => {
  await p.context.addInitScript(() => {
    const real = window.fetch;
    const notes = [{ seq: 4, at: new Date().toISOString(), reason: 'T-9 holds a building slot with no Dev, for 12 minutes.', say: 'T-9 holds a slot and has no Dev.', terminal: null, ticket: 'T-9', filed: 'T-20' }, { seq: 3, at: new Date(Date.now() - 3600000).toISOString(), reason: 'Old news.', say: 'Old.', terminal: null, ticket: null, filed: null }];
    window.fetch = (url, opts) => (String(url).includes('/manager?') ? Promise.resolve(new Response(JSON.stringify({ ok: true, notes }), { status: 200 })) : real(url, opts));
  });
  await p.open();
  await until(p, () => [...document.querySelectorAll('#feed li')].some((li) => li.textContent.includes('The manager: T-9 holds a building slot with no Dev, for 12 minutes. Filed as T-20.')));
  const polls = await p.page.evaluate(() => new Promise((done) => { let n = 0; const real = window.fetch; window.fetch = (url, opts) => { if (String(url).includes('/manager?') && ++n === 2) done(n); return real(url, opts); }; }));
  assert.strictEqual(polls, 2);
  const lines = await p.page.evaluate(() => [...document.querySelectorAll('#feed li')].map((li) => li.textContent).filter((t) => t.includes('The manager: ')));
  assert.strictEqual(lines.length, 1, 'once, and not the old one: ' + lines);
});
