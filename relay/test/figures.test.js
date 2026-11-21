// The figures (office/figures.js): every robot design keeps the skeleton the poses turn, with each
// joint where buildPerson in office/office.js always put it, and ?edition= or the roster picks the
// edition. Each design is built here with three.js from node_modules. Nothing here runs a browser.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const THREE = require('three');
const figures = require('../../office/figures.js');
const roster = require('../../office/roster.js');
const { RIG } = require('../../office/poses.js');

// A kit with the same functions office.js passes. Where a part sits on its joint does not matter here.
const C = (hex) => new THREE.Color(hex);
const std = (hex, o) => new THREE.MeshStandardMaterial(Object.assign({ color: C(hex) }, o || {}));
const metal = (hex, r) => std(hex, { metalness: 0.75, roughness: r == null ? 0.35 : r });
function mesh(geo, mat, parent) { const m = new THREE.Mesh(geo, mat); if (parent) parent.add(m); return m; }
function ball(parent, mat, p, r) { const m = mesh(new THREE.SphereGeometry(r, 6, 4), mat, parent); m.position.set(p[0], p[1], p[2]); return m; }
function block(parent, mat, p, size) { const m = mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat, parent); m.position.set(p[0], p[1], p[2]); return m; }
function cyl(parent, mat, p, r, h) { const m = mesh(new THREE.CylinderGeometry(r, r, h, 6), mat, parent); m.position.set(p[0], p[1], p[2]); return m; }
function rod(parent, mat, a, b, r) { const m = mesh(new THREE.CylinderGeometry(r, r, 1, 6), mat, parent); m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2); return m; }
// A canvas that takes every drawing call and draws nothing, since Node has no canvas.
function makeCanvas(width, height) {
  const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : k === 'measureText' ? () => ({ width: 100 }) : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
  return { width, height, getContext: () => ctx };
}
const tex = (c) => Object.assign(new THREE.Texture(), { canvas: c });
const KIT = { THREE, RIG, C, std, metal, mesh, ball, block, cyl, rod, makeCanvas, tex };

// Where buildPerson put each joint, in the figure's own units, and the joint each one hangs from.
const JOINTS = {
  pelvis: { at: [0, 0.94, 0], on: 'root' },
  spine: { at: [0, RIG.spine, 0], on: 'pelvis' },
  neck: { at: [0, 0.48, 0], on: 'spine' },
  head: { at: [0, 0.17, 0], on: 'neck' },
  'arms.L.sh': { at: [RIG.shoulderX, RIG.shoulderY, 0], on: 'spine' },
  'arms.R.sh': { at: [-RIG.shoulderX, RIG.shoulderY, 0], on: 'spine' },
  'arms.L.el': { at: [0, -RIG.upperArm, 0], on: 'arms.L.sh' },
  'arms.R.el': { at: [0, -RIG.upperArm, 0], on: 'arms.R.sh' },
  'hands.L': { at: [0, -RIG.forearm, 0], on: 'arms.L.el' },
  'hands.R': { at: [0, -RIG.forearm, 0], on: 'arms.R.el' },
  'legs.L.hip': { at: [0.085, -0.02, 0], on: 'pelvis' },
  'legs.R.hip': { at: [-0.085, -0.02, 0], on: 'pelvis' },
  'legs.L.knee': { at: [0, -0.43, 0], on: 'legs.L.hip' },
  'legs.R.knee': { at: [0, -0.43, 0], on: 'legs.R.hip' }
};
const part = (f, name) => name.split('.').reduce((o, k) => o[k], f);
const round = (v) => Math.round(v * 1e6) / 1e6;

function checkSkeleton(f, height, label) {
  assert.ok(f.root.isGroup, label + ': a root group');
  assert.deepStrictEqual(f.root.scale.toArray().map(round), [height, height, height], label + ': the root is scaled to the height');
  for (const [name, j] of Object.entries(JOINTS)) {
    const g = part(f, name);
    assert.ok(g && g.isGroup, label + ': ' + name + ' is a group');
    assert.deepStrictEqual(g.position.toArray().map(round), j.at.map(round), label + ': ' + name + ' is where buildPerson put it');
    assert.deepStrictEqual(g.rotation.toArray().slice(0, 3), [0, 0, 0], label + ': ' + name + ' starts unturned');
    assert.strictEqual(g.parent, part(f, j.on), label + ': ' + name + ' hangs from ' + j.on);
  }
}
const meshesOn = (g) => g.children.filter((c) => c.isMesh).length;

test('the skeleton has each joint where buildPerson put it, nested the way the poses turn it', () => {
  for (const height of [0.8, 1, 1.1]) checkSkeleton(figures.skeleton(THREE, RIG, height), height, 'skeleton ' + height);
});

test('a robot of each design keeps the skeleton, with parts on every joint and none moved', () => {
  assert.ok(figures.DESIGNS.length >= 1);
  for (const design of figures.DESIGNS) for (const height of [0.8, 0.95, 1.1]) {
    const label = design + ' at ' + height;
    const f = figures.robot(KIT, { design, height, color: '#8fd19e' });
    assert.strictEqual(f.design, design, label);
    checkSkeleton(f, height, label);
    for (const name of ['pelvis', 'spine', 'neck', 'head', 'arms.L.sh', 'arms.R.sh', 'arms.L.el', 'arms.R.el', 'hands.L', 'hands.R', 'legs.L.hip', 'legs.R.hip', 'legs.L.knee', 'legs.R.knee']) {
      assert.ok(meshesOn(part(f, name)) > 0, label + ': ' + name + ' carries a part, so nothing floats');
    }
    let cast = 0, all = 0;
    f.root.traverse((o) => { if (o.isMesh) { all++; if (o.castShadow) cast++; } });
    assert.strictEqual(cast, all, label + ': every part casts a shadow, as a person does');
    assert.ok(f.hatTop > 0.1 && f.hatTop < 0.3, label + ': a party hat sits on top of the head, at ' + f.hatTop);
    if (f.tick) for (const mood of ['idle', 'work', 'wait', 'couch', 'party']) for (const still of [false, true]) {
      f.tick(0.4, { mood, still });
      checkSkeleton(f, height, label + ' after a tick, ' + mood + (still ? ', still' : ''));
    }
  }
});

test('each design shows the role color in a light', () => {
  for (const design of figures.DESIGNS) {
    const f = figures.robot(KIT, { design, color: '#c79be0' }), want = C('#c79be0');
    let lit = 0;
    f.root.traverse((o) => { if (o.isMesh && o.material.emissive && o.material.emissive.equals(want)) lit++; });
    assert.ok(lit > 0, design + ' has a part that glows in the role color');
  }
});

test('there are five designs, and each desk in the roster has one of them', () => {
  assert.deepStrictEqual(figures.DESIGNS.slice().sort(), ['ilium', 'pebble', 'tin', 'tty', 'visor']);
  const designs = roster.editions.robots.designs;
  for (const def of [roster.lead].concat(roster.workers)) {
    assert.ok(figures.DESIGNS.includes(designs[def.id]), def.id + ' has a design: ' + designs[def.id]);
    assert.strictEqual(figures.deskFigure(roster, 'robots', def).design, designs[def.id], def.id + ' is drawn in its design');
  }
  assert.deepStrictEqual(Object.keys(designs).sort(), [roster.lead].concat(roster.workers).map((d) => d.id).sort(), 'no design for a desk the roster does not have, and none for the manager');
});

test('a design the roster does not know is the Tin Toy', () => {
  assert.strictEqual(figures.robot(KIT, { design: 'toaster' }).design, 'tin');
  assert.strictEqual(figures.robot(KIT, { design: 'constructor' }).design, 'tin');
  assert.strictEqual(figures.robot(KIT, {}).design, 'tin');
});

test('?edition= in the address picks a known edition, else the roster does, else people', () => {
  const R = (edition) => ({ edition, editions: { robots: { figure: 'robot' }, xmas: { figure: 'robot' } } });
  assert.strictEqual(figures.edition('', {}), 'people');
  assert.strictEqual(figures.edition('', null), 'people');
  assert.strictEqual(figures.edition('', R('people')), 'people');
  assert.strictEqual(figures.edition('', R('robots')), 'robots');
  assert.strictEqual(figures.edition('', R('xmas')), 'xmas');
  assert.strictEqual(figures.edition('?edition=robots', R('people')), 'robots');
  assert.strictEqual(figures.edition('?channel=office&edition=xmas&key=k', R('robots')), 'xmas');
  assert.strictEqual(figures.edition('?edition=people', R('robots')), 'people', 'the address wins over the roster');
  assert.strictEqual(figures.edition('?trailer', R('robots')), 'robots', 'the trailer shows the roster\'s edition');
  assert.strictEqual(figures.edition('?edition=pirates', R('robots')), 'robots', 'an edition the roster does not have falls back to the roster');
  assert.strictEqual(figures.edition('', { edition: 'pirates' }), 'people', 'and so does a roster edition with no entry');
  assert.strictEqual(figures.edition('?edition=constructor', R('people')), 'people', 'a name only an object has is not an edition');
  assert.strictEqual(figures.edition('?edition=robots', {}), 'people', 'a roster with no editions has only people');
});

test('an edition with figure robot draws each desk as a robot in its color and height, and people otherwise', () => {
  const R = { editions: { robots: { figure: 'robot' }, plain: {} } };
  const def = { id: 'priya', color: '#f08c7e', look: { height: 0.95 } };
  assert.deepStrictEqual(figures.deskFigure(R, 'robots', def), { design: undefined, height: 0.95, color: '#f08c7e' });
  assert.strictEqual(figures.deskFigure(R, 'people', def), null);
  assert.strictEqual(figures.deskFigure(R, 'plain', def), null, 'an edition with no figure keeps people');
  assert.strictEqual(figures.deskFigure(R, 'missing', def), null);
  assert.deepStrictEqual(figures.deskFigure(R, 'robots', { id: 'x' }), { design: undefined, height: 1, color: '#9fd3ff' });
});

test('the roster ships with people, and has the robot edition to switch to', () => {
  assert.strictEqual(roster.edition, 'people');
  assert.strictEqual(roster.editions.robots.figure, 'robot');
});
