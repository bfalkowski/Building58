// Throw a party (office/office.js, WebGL off): everyone wears a hat, the free people gather round the
// cake, and anyone working or waiting on you stays at their desk with their state as it was. The party
// ends by itself, or on a second press, and everyone goes back to their desk.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { office, pageTest, until } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;

// Who is where, as the page sees it.
const look = (p) => p.page.evaluate(() => {
  const s = window.run.state();
  return { party: s.party, people: s.workers.filter((w) => w.present).map((w) => Object.assign({ id: w.id, status: w.status, doing: w.doing }, window.run.debug(w.id))) };
});

pageTest('a party puts hats on everyone and gathers only the free people, then sends them back', get, async (p) => {
  await p.open();
  const page = p.page;
  await page.evaluate(() => window.run.ready());
  // The Lead works and then waits on you, one Dev works, and one Dev is free.
  const ids = await page.evaluate(() => { const s = window.run.state().workers.filter((w) => w.present); return s.map((w) => w.id); });
  const [leadId, freeId, busyId] = ids;
  await page.evaluate(([l, b]) => Promise.all([window.run.do({ action: 'work', who: l, label: 'lead work' }), window.run.do({ action: 'work', who: b, label: 'dev work' })]), [leadId, busyId]);
  await until(p, (ids) => ids.every((id) => { const d = window.run.debug(id); return d.seated && d.step && d.step.t === 'act'; }), [leadId, busyId]);
  await page.evaluate(() => window.run.do({ action: 'waiting', message: 'Allow Bash?' }));
  const before = await look(p);
  const desks = Object.fromEntries(before.people.map((w) => [w.id, w.spot]));
  assert.strictEqual(before.party.on, false);
  assert.ok(before.people.every((w) => !w.hat), 'no hats before the party');

  // Throw a party.
  const btn = page.locator('#party-btn');
  assert.strictEqual(await btn.innerText(), 'Throw a party');
  await btn.click();
  assert.strictEqual(await btn.getAttribute('aria-pressed'), 'true');
  assert.strictEqual(await btn.innerText(), 'End the party');
  const during = await look(p);
  assert.ok(during.party.on && during.party.secondsLeft > 45 && during.party.secondsLeft <= 60, 'it lasts about a minute: ' + during.party.secondsLeft);
  assert.ok(during.people.every((w) => w.hat), 'everyone wears a hat');
  assert.deepStrictEqual(during.party.guests, [freeId], 'only the free Dev goes to the party');
  // A loaded runner draws few frames, so room time runs fast from here. The manager does not walk in on a party.
  await page.evaluate(() => window.run.speed({ value: 8 }));
  await until(p, (id) => { const d = window.run.debug(id); return /^(party-|couch-|armchair)/.test(d.spot) && d.step && d.step.t === 'act'; }, freeId);
  const there = await look(p);
  const byId = Object.fromEntries(there.people.map((w) => [w.id, w]));
  assert.strictEqual(byId[freeId].doing, 'At the party');
  // The busy and the waiting stay at their desks, in hats, and say what they really do.
  assert.strictEqual(byId[busyId].spot, desks[busyId]);
  assert.strictEqual(byId[busyId].status, 'working');
  assert.strictEqual(byId[leadId].spot, desks[leadId]);
  assert.strictEqual(byId[leadId].status, 'waiting');
  assert.ok(byId[busyId].hat && byId[leadId].hat);

  // A second press ends it: the candles go out, then the hats come off and the guest goes back.
  await btn.click();
  assert.strictEqual(await btn.innerText(), 'Throw a party');
  await until(p, () => !window.run.state().party.on);
  const after = await look(p);
  assert.ok(after.people.every((w) => !w.hat), 'the hats are off');
  const atDesk = /^([ab]\d|lead)$/;
  await until(p, ([id, desk]) => { const d = window.run.debug(id); return d.seated && d.step && d.step.t === 'act' && new RegExp(desk).test(d.spot); }, [freeId, atDesk.source]);
  assert.strictEqual((await look(p)).people.find((w) => w.id === leadId).status, 'waiting', 'the waiting Lead was never touched');

  // A party also ends by itself: a minute by default, five seconds of room time here.
  await page.evaluate(() => window.run.do({ action: 'party', on: true, seconds: 5 }));
  await until(p, () => !window.run.state().party.on);
  assert.ok((await look(p)).people.every((w) => !w.hat));
  assert.deepStrictEqual(p.errors, []);
});

pageTest('someone on the couch stays there for the party, no new game starts, and "on" takes only true or false', get, async (p) => {
  await p.open();
  const page = p.page;
  await page.evaluate(() => window.run.ready());
  const bad = await page.evaluate(() => Promise.all([0, '0', 'yes', ['true']].map((on) => window.run.do({ action: 'party', on }))));
  assert.ok(bad.every((r) => !r.ok && r.error === 'bad_param'), 'odd values of "on" are refused');
  assert.strictEqual(await page.evaluate(() => window.run.state().party.on), false);

  // One free person sits on the couch.
  const id = await page.evaluate(() => window.run.state().workers.find((w) => w.present && w.status === 'idle').id);
  await page.evaluate(() => window.run.speed({ value: 4 }));
  await page.evaluate((who) => window.run.do({ action: 'idle', who, do: 'couch' }), id);
  await until(p, (who) => { const d = window.run.debug(who); return /^couch-/.test(d.spot) && d.seated && d.step && d.step.t === 'act'; }, id);
  const seat = (await page.evaluate((who) => window.run.debug(who), id)).spot;
  await page.evaluate(() => window.run.do({ action: 'party', on: true }));
  const d = await page.evaluate((who) => window.run.debug(who), id);
  assert.strictEqual(d.spot, seat, 'they stay on the couch');
  assert.ok(!d.steps.some((t) => /^(stand|walk)/.test(t)), 'with no walk queued: ' + d.steps);
  assert.ok((await page.evaluate(() => window.run.state().party.guests)).includes(id), 'and are at the party');

  // Nobody starts ping pong on their own while it is on: chooseIdle is driven a while at speed.
  await page.evaluate(() => window.run.speed({ value: 8 }));
  await page.waitForTimeout(3000);
  assert.ok(await page.evaluate(() => window.run.state().workers.every((w) => !/^pp-/.test(window.run.debug(w.id).spot))), 'nobody went to the table');
  await page.evaluate(() => window.run.do({ action: 'party', on: false }));
  assert.deepStrictEqual(p.errors, []);
});
