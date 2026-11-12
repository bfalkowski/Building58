// The baked look (office/look.js): which parts of the room it bakes, how it knows them again on the
// next load, and that the bake in office/baked/ matches those rules.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const THREE = require('three');
const look = require('../../office/look.js');

const BAKED = path.join(__dirname, '..', '..', 'office', 'baked');
const std = () => new THREE.MeshStandardMaterial({ color: 0x8a6a4a });
function part(size, mat, parent) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), mat || std());
  (parent || new THREE.Scene()).add(m);
  m.updateMatrixWorld(true);
  return m;
}

test('?look=baked asks for the baked look, and anything else is the live look', () => {
  assert.strictEqual(look.wanted('?look=baked'), 'baked');
  assert.strictEqual(look.wanted('?time=evening&look=baked'), 'baked');
  assert.strictEqual(look.wanted(''), 'live');
  assert.strictEqual(look.wanted('?look=photo'), 'live');
});

test('the effects come with the baked look, and fx=off turns them off', () => {
  assert.strictEqual(look.wantFx('?look=baked'), true);
  assert.strictEqual(look.wantFx('?look=baked&fx=off'), false);
  assert.strictEqual(look.wantFx('?fx=on'), false, 'not without the baked look');
  assert.strictEqual(look.wantFx(''), false);
  for (const src of look.ADDONS) assert.match(src, /^https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.128\.0\/examples\/js\//, 'the same three.js as the page, at its exact version');
});

test('a part has the same key on every load, and a part that moved has a new one', () => {
  const a = part(1), b = part(1);
  assert.strictEqual(look.meshKey(a), look.meshKey(b));
  b.position.x += 0.02; b.updateMatrixWorld(true);
  assert.notStrictEqual(look.meshKey(a), look.meshKey(b));
  const c = part(1); c.material.color.set(0x112233);
  assert.notStrictEqual(look.meshKey(a), look.meshKey(c), 'a new colour is a new part');
});

test('only big, lit, solid parts that do not move are baked', () => {
  const none = new Set();
  assert.ok(look.bakeable(part(1), none), 'a desk-sized box');
  assert.ok(!look.bakeable(part(look.MIN_SIZE / 3), none), 'a mug stays live');
  assert.ok(!look.bakeable(part(1, new THREE.MeshBasicMaterial()), none), 'a screen, a sign or the sky stays live');
  assert.ok(!look.bakeable(part(1, new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.1 })), none), 'glass stays live');
  const person = new THREE.Group(); new THREE.Scene().add(person);
  assert.ok(!look.bakeable(part(1, null, person), new Set([person])), 'a person, or anything under one, moves');
  const hidden = new THREE.Group(); hidden.visible = false; new THREE.Scene().add(hidden);
  assert.ok(!look.bakeable(part(1, null, hidden), none), 'what is not shown now is not baked');
});

test('the bake in office/baked/ has one key per part, a light for each time of day, and names each material after a part in it', () => {
  const bake = JSON.parse(fs.readFileSync(path.join(BAKED, 'bake.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(bake.times).sort(), ['day', 'evening', 'night']);
  for (const [time, t] of Object.entries(bake.times)) {
    assert.ok(t.lightMapIntensity > 0 && t.ambientScale > 0, time);
    assert.strictEqual(t.sun.from.length, 3, time + ': where the sun shines from');
    assert.ok(fs.statSync(path.join(BAKED, t.light)).size > 1000, time + ': ' + t.light);
    assert.ok(look.FX[time], time + ': the effects have settings for it');
  }
  assert.ok(bake.keys.length > 300, 'the room has hundreds of baked parts');
  assert.strictEqual(new Set(bake.keys).size, bake.keys.length, 'no two parts share a key');
  assert.ok(bake.aoMapIntensity > 0);
  // room.glb: a GLB's first chunk is its JSON.
  const glb = fs.readFileSync(path.join(BAKED, 'room.glb'));
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  assert.ok(!json.images, 'the room keeps its own textures, so the copy carries none');
  const keys = new Set(bake.keys);
  for (const m of json.materials) assert.ok(keys.has(m.name.split('#')[0]), 'material ' + m.name + ' is named after a baked part');
  for (const prim of json.meshes.flatMap((m) => m.primitives)) assert.ok('TEXCOORD_1' in prim.attributes, 'every part has the bake\'s UVs');
  assert.ok(fs.statSync(path.join(BAKED, 'ao.png')).size > 1000, 'ao.png');
});
