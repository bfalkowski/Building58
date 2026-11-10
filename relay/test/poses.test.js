// A seated person's arms never pass through their desk, from office/poses.js. Each move between
// the seated poses is played frame by frame the way office/office.js plays it (applyPose), and
// each frame the forearm and hand are checked against the desk top. Nothing here runs a browser.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { POSE, RIG, typePoseFor, aimArms, towards, ARM_CARRY_SIT, ARM_SIP } = require('../../office/poses.js');

// The desk top is 0.70 to 0.75 high. Its front edge is 0.27 in front of the chair's spot at the
// Lead's desk and 0.29 at the benches (desk() and bench() in office/office.js), so 0.27 holds for
// both. Measured here from the rig, not from poses.js, so a wrong check there cannot hide a hit.
const TOP = 0.75, UNDER = 0.70, EDGE = 0.27;
// office/roster.js asks for heights from 0.8 to 1.1.
const HEIGHTS = [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1];
const FPS = [30, 60, 144];

const rx = (a, [x, y, z]) => [x, y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
const rz = (a, [x, y, z]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z];
const add = (a, b) => a.map((v, i) => v + b[i]);
// Points along one arm, from the elbow to the hand, as [forward, up, radius], the way
// buildPerson nests the groups: spine leans at the pelvis, the shoulder turns x then z, the elbow turns x.
function armPoints(p, side, height) {
  const s = side === 'L' ? 1 : -1, sz = side === 'L' ? p.sLz : -p.sRz;
  const out = [];
  for (let i = 0; i <= 10; i++) {
    const u = i / 10;
    let v = rx(p['s' + side + 'x'], rz(sz, add([0, -RIG.upperArm, 0], rx(p['e' + side], [0, -RIG.forearm * u, 0]))));
    v = add(rx(p.lean, add(v, [RIG.shoulderX * s, RIG.shoulderY, 0])), [0, RIG.spine + p.py, 0]);
    out.push([v[2] * height, v[1] * height, (i === 0 || i === 10 ? 0.048 : 0.041) * height]);  // the elbow and hand balls, and the forearm
  }
  return out;
}
// How deep any part of either arm is in the desk top, in metres. ahead moves the person forward.
function depth(p, height, ahead) {
  let worst = 0;
  for (const side of ['L', 'R']) for (const [z0, y, r] of armPoints(p, side, height)) {
    const z = z0 + ahead, inY = Math.min(y + r - UNDER, TOP - (y - r)), inZ = z + r - EDGE;
    if (inY > 0 && inZ > 0) worst = Math.max(worst, Math.min(inY, inZ));
  }
  return worst;
}
// Plays one move like applyPose: the arms take their route while the person is in the chair,
// or still within 3 cm of it as they get up. ahead(t) is how far in front of the chair they are.
function play(from, to, height, fps, ahead = () => 0, seated = true) {
  const p = Object.assign({}, from), route = {}, dt = 1 / fps;
  let worst = 0;
  for (let t = 0; t < 3; t += dt) {
    const off = ahead(t), aim = seated || off < 0.03 ? aimArms(route, p, to, height, off) : to;
    towards(p, aim, Math.min(1, dt * 7));
    worst = Math.max(worst, depth(p, height, off));
  }
  const left = Math.max(...Object.keys(to).map((j) => Math.abs(p[j] - to[j])));
  return { worst, left };
}

const seatedPoses = (height) => ({
  sit: POSE.sit, type: typePoseFor(height), leanback: POSE.leanback, stretch: POSE.stretch, phone: POSE.phoneSit, wave: POSE.wave,
  mug: Object.assign({}, POSE.sit, ARM_CARRY_SIT), sip: Object.assign({}, POSE.sit, ARM_SIP)
});

test('every seated pose rests clear of the desk, for every height', () => {
  for (const h of HEIGHTS) for (const [name, pose] of Object.entries(seatedPoses(h))) {
    assert.strictEqual(depth(pose, h, 0), 0, `${name} at height ${h}`);
  }
});

test('no move between seated poses passes an arm through the desk, and each one arrives', () => {
  const hits = [];
  for (const h of HEIGHTS) for (const fps of FPS) {
    const P = seatedPoses(h);
    for (const a of Object.keys(P)) for (const b of Object.keys(P)) {
      if (a === b) continue;
      const { worst, left } = play(P[a], P[b], h, fps);
      if (worst > 0.001) hits.push(`${a} to ${b}, height ${h}, ${fps} fps: ${(worst * 1000).toFixed(0)} mm deep`);
      assert.ok(left < 0.01, `${a} to ${b}, height ${h}, ${fps} fps, ends ${left.toFixed(3)} off its pose`);
    }
  }
  assert.deepStrictEqual(hits, []);
});

test('sitting down and getting up keep the hands out of the desk', () => {
  // The sit step slides the person from 0.14 in front of the chair to it in 0.6 s, and the stand
  // step slides them back out in 0.55 s (tickWorker in office/office.js).
  const hits = [];
  for (const h of HEIGHTS) for (const fps of FPS) {
    const down = play(POSE.stand, POSE.sit, h, fps, (t) => 0.14 * (1 - Math.min(1, t / 0.6)));
    const up = play(POSE.sit, POSE.stand, h, fps, (t) => 0.14 * Math.min(1, t / 0.55), false);
    if (down.worst > 0.001) hits.push(`sitting down, height ${h}, ${fps} fps: ${(down.worst * 1000).toFixed(0)} mm`);
    if (up.worst > 0.001) hits.push(`getting up, height ${h}, ${fps} fps: ${(up.worst * 1000).toFixed(0)} mm`);
  }
  assert.deepStrictEqual(hits, []);
});
