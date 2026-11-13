// The trailer (office/trailer.js, WebGL off): ?trailer turns the page into a full-screen film with its
// own overlay, starts it once the room is built, and keeps the camera off the mouse. Without
// ?trailer the page has none of it. The pictures themselves are checked by eye, with
// npm run trailer -- --stills.
'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { office, pageTest, until } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;

pageTest('?trailer plays the film over the scene, and the room still answers where things are', get, async (p) => {
  await p.page.goto(o.address + '&trailer');
  await until(p, () => document.documentElement.dataset.trailer === 'playing');
  const s = await p.page.evaluate(() => ({
    on: document.documentElement.classList.contains('trailer'),
    overlay: !!document.getElementById('trailer'),
    length: window.trailer.length,
    neon: window.run.where('neon'),
    screen: window.run.where('screen:lead'),
    nobody: window.run.where('nobody'),
    floor: getComputedStyle(document.querySelector('.floor')).visibility
  }));
  assert.ok(s.on && s.overlay, 'the page is in trailer mode');
  assert.ok(s.length > 60 && s.length < 120, 'the film is one to two minutes: ' + s.length);
  assert.deepStrictEqual(s.neon.at.length, 3);
  assert.ok(s.screen.at && s.screen.facing, 'a monitor has a place and a way it faces');
  assert.strictEqual(s.nobody, null);
  assert.strictEqual(s.floor, 'hidden', 'the side panels are hidden');
  // The film brings the whole roster in.
  await until(p, () => window.run.state().workers.every((w) => w.present));
  assert.deepStrictEqual(p.errors, []);
});

pageTest('without ?trailer the page has no film', get, async (p) => {
  await p.open();
  const s = await p.page.evaluate(() => ({ on: document.documentElement.classList.contains('trailer'), overlay: !!document.getElementById('trailer'), film: 'trailer' in window }));
  assert.deepStrictEqual(s, { on: false, overlay: false, film: false });
  assert.deepStrictEqual(p.errors, []);
});
