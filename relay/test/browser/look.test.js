// The baked look (office/look.js) in a real browser, drawn in software. ?look=baked swaps every still
// part the bake knows for the baked copy, keeps people live, and follows the Light: day, evening and
// night each have their own bake. No test reads what the scene draws.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { office, pageTest, SOFTWARE } = require('./page.js');

let o;
test.before(async () => { o = await office({ webgl: true }); });
test.after(() => o && o.stop());
const look = (p) => p.page.evaluate(() => Object.assign({}, window.OfficeLook.state));

pageTest('?look=baked follows the Light: day, evening and night each show their own bake and effects', () => o, async (p) => {
  const page = p.page;
  await page.goto(o.address + '&look=baked&time=evening');
  await page.locator('#relay-status[data-state="on"]').waitFor();
  await page.evaluate(() => window.run.ready());
  await page.waitForFunction(() => window.OfficeLook.state.status !== 'loading' && window.OfficeLook.state.status !== 'off');
  let s = await look(p);
  assert.strictEqual(s.error, null);
  assert.deepStrictEqual([s.status, s.time], ['baked', 'evening']);
  assert.strictEqual(s.missing, 0, 'every part in the bake was found in the room');
  assert.ok(s.hidden > 300, 'the still parts are swapped for the baked copy');
  await page.waitForFunction(() => window.OfficeLook.state.fx !== 'loading');
  assert.strictEqual((await look(p)).fx, 'on', 'the effects draw the baked look');
  assert.strictEqual(await page.evaluate(() => window.THREE.EffectComposer !== undefined), true);

  for (const time of ['day', 'night', 'evening']) {
    await page.evaluate((t) => window.run.time(t), time);
    await page.waitForFunction((t) => window.OfficeLook.state.time === t, time);
    s = await look(p);
    assert.deepStrictEqual([s.status, s.time, s.fx], ['baked', time, 'on'], time + ' has its own bake, with its effects');
    assert.ok(s.hidden > 300, time);
  }
  assert.deepStrictEqual(p.errors, []);
}, SOFTWARE);

// Runs in the page before its scripts. Counts every shader program the page links, and notes the
// count at the moment the look swaps to the bake.
function countLinks() {
  window.__links = 0;
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    const link = C.prototype.linkProgram, source = C.prototype.shaderSource;
    // Which shader: its name and the features it was built for, so a failure says what compiled late.
    C.prototype.shaderSource = function (shader, src) { window.__lastShader = String(src).split('\n').filter((l) => /^#define (SHADER_NAME|USE_|NUM_|FOG|DOUBLE_SIDED|FLAT_SHADED|USE_SHADOWMAP)/.test(l)).join(', '); return source.call(this, shader, src); };
    C.prototype.linkProgram = function (program) { window.__links++; if (window.__atSwap !== undefined) (window.__late = window.__late || []).push(window.__lastShader); return link.call(this, program); };
  }
  let api;
  Object.defineProperty(window, 'OfficeLook', { configurable: true, get: () => api, set: (v) => {
    api = v;
    let status = v.state.status;
    Object.defineProperty(v.state, 'status', { enumerable: true, get: () => status, set: (s) => {
      if (s === 'baked' && window.__atSwap === undefined) window.__atSwap = window.__links;
      status = s;
    } });
  } });
}
const frames = (page, n) => page.evaluate((count) => new Promise((done) => {
  let left = count;
  const tick = () => (--left > 0 ? requestAnimationFrame(tick) : done());
  requestAnimationFrame(tick);
}), n);

// A shader compiles in one go, and the people stand still while it does. The load compiles every
// shader the swap needs before the swap, a few a frame, so the swap and the frames after it compile none.
pageTest('the swap to the baked look compiles no shader, with the effects and without', () => o, async (p) => {
  const page = p.page;
  await page.addInitScript(countLinks);
  for (const fx of ['', '&fx=off']) {
    await page.goto(o.address + '&look=baked&time=evening' + fx);
    await page.locator('#relay-status[data-state="on"]').waitFor();
    await page.evaluate(() => window.run.ready());
    await page.waitForFunction(() => window.OfficeLook.state.status === 'baked' && window.OfficeLook.state.fx !== 'loading');
    await frames(page, 10);
    const s = await page.evaluate(() => ({ fx: window.OfficeLook.state.fx, atSwap: window.__atSwap, links: window.__links, late: window.__late || [] }));
    assert.strictEqual(s.fx, fx ? 'off' : 'on');
    assert.ok(s.atSwap > 0, 'the room linked its shaders before the swap');
    assert.strictEqual(s.links - s.atSwap, 0, 'shaders linked at the swap or after it, with fx ' + s.fx + ': ' + JSON.stringify(s.late));
  }
  assert.deepStrictEqual(p.errors, []);
}, SOFTWARE);

pageTest('fx=off keeps the baked look and leaves out its effects', () => o, async (p) => {
  const page = p.page;
  await page.goto(o.address + '&look=baked&fx=off');
  await page.locator('#relay-status[data-state="on"]').waitFor();
  await page.evaluate(() => window.run.ready());
  await page.waitForFunction(() => window.OfficeLook.state.status === 'baked');
  assert.strictEqual((await look(p)).fx, 'off');
  assert.strictEqual(await page.evaluate(() => window.THREE.EffectComposer === undefined), true, 'the effects are not fetched');
  assert.deepStrictEqual(p.errors, []);
}, SOFTWARE);

pageTest('without ?look=baked the room loads nothing for it', () => o, async (p) => {
  await p.open();
  await p.page.evaluate(() => window.run.ready());
  const s = await look(p);
  assert.deepStrictEqual([s.look, s.status, s.hidden], ['live', 'off', 0]);
  assert.strictEqual(await p.page.evaluate(() => !!window.THREE.GLTFLoader), false, 'the loader is fetched only for the baked look');
  assert.deepStrictEqual(p.errors, []);
}, SOFTWARE);
