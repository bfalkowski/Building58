// The figures (office/figures.js): every robot design keeps the skeleton the poses turn, with each
// joint where buildPerson in office/office.js always put it, and ?robots or the roster picks the
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
const KIT = { THREE, RIG, C, std, metal, mesh, ball, block, cyl, rod };

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
    if (f.tick) { f.tick(0.016, {}); checkSkeleton(f, height, label + ' after a tick'); }
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

test('a design the roster does not know is the Tin Toy', () => {
  assert.strictEqual(figures.robot(KIT, { design: 'toaster' }).design, 'tin');
  assert.strictEqual(figures.robot(KIT, { design: 'constructor' }).design, 'tin');
  assert.strictEqual(figures.robot(KIT, {}).design, 'tin');
});

test('?robots in the address or edition in the roster picks robots, and ?robots=off wins over the roster', () => {
  assert.strictEqual(figures.edition('', {}), 'people');
  assert.strictEqual(figures.edition('', { edition: 'people' }), 'people');
  assert.strictEqual(figures.edition('', { edition: 'robots' }), 'robots');
  assert.strictEqual(figures.edition('?robots', {}), 'robots');
  assert.strictEqual(figures.edition('?channel=office&robots&key=k', { edition: 'people' }), 'robots');
  assert.strictEqual(figures.edition('?robots=on', {}), 'robots');
  assert.strictEqual(figures.edition('?robots=off', { edition: 'robots' }), 'people');
  assert.strictEqual(figures.edition('?trailer', { edition: 'robots' }), 'robots');
  assert.strictEqual(figures.edition('?robots', null), 'robots');
});

test('the manager stays a person, in his robotEditionLook in the robot edition and his look otherwise', () => {
  const M = { look: { top: 'suit' }, robotEditionLook: { top: 'suit', hat: '#4a443d' } };
  assert.strictEqual(figures.managerLook(M, 'robots'), M.robotEditionLook);
  assert.strictEqual(figures.managerLook(M, 'people'), M.look);
  assert.strictEqual(figures.managerLook({ look: M.look }, 'robots'), M.look, 'with no robotEditionLook he keeps his look');
  assert.strictEqual(figures.managerLook(undefined, 'robots'), undefined);
  const retro = roster.manager.robotEditionLook;
  assert.ok(retro, 'the roster has a robotEditionLook for the manager');
  assert.strictEqual(retro.top, 'suit');
  assert.ok(retro.hat && retro.extra === 'browline' && retro.clip && retro.square, 'a fedora, browline glasses, a tie clip and a pocket square');
  assert.ok(retro.height >= 0.8 && retro.height <= 1.1, 'a height the desk poses fit');
  assert.ok(!roster.manager.look.hat, 'his everyday look has no hat');
  for (const def of [roster.lead].concat(roster.workers)) assert.ok(!def.look.hat && def.look.extra !== 'browline', def.id + ' gets no hat and no browline glasses');
});

test('the roster ships with people', () => {
  assert.strictEqual(roster.edition, 'people');
});
