// The people's poses, and the route an arm takes at a desk. Plain data and functions, so the
// tests can run them. Loaded by office/index.html before office.js, and by
// relay/test/poses.test.js with require.
(function () {
  'use strict';
  // A rig of groups: pelvis -> spine -> neck -> head, shoulders -> elbows -> hands, hips -> knees.
  // A pose is a set of joint angles in radians. Facing +z, negative x rotation swings a limb forward.
  const POSE = {
    stand:    { py: 0.94, lean: 0.0, hx: 0, hy: 0, sLx: 0.04, sLz: 0.08, eL: -0.14, sRx: 0.04, sRz: 0.08, eR: -0.14, hipL: 0, kL: 0, hipR: 0, kR: 0 },
    pockets:  { py: 0.94, lean: -0.02, hx: -0.04, hy: 0, sLx: 0.12, sLz: 0.2, eL: -0.45, sRx: 0.12, sRz: 0.2, eR: -0.45, hipL: 0, kL: 0, hipR: 0.05, kR: 0.08 },
    sit:      { py: 0.52, lean: 0.0, hx: 0.05, hy: 0, sLx: 0.29, sLz: -0.25, eL: -1.41, sRx: 0.29, sRz: -0.25, eR: -1.41, hipL: -1.52, kL: 1.48, hipR: -1.52, kR: 1.48 },
    type:     { py: 0.52, lean: 0.0, hx: 0.16, hy: 0, sLz: -0.15, sRz: -0.15, hipL: -1.52, kL: 1.48, hipR: -1.52, kR: 1.48 },
    leanback: { py: 0.52, lean: -0.2, hx: -0.18, hy: 0, sLx: -2.75, sLz: 0.55, eL: -2.3, sRx: -2.75, sRz: 0.55, eR: -2.3, hipL: -1.45, kL: 1.3, hipR: -1.45, kR: 1.3 },
    stretch:  { py: 0.52, lean: -0.12, hx: -0.25, hy: 0, sLx: -3.05, sLz: 0.18, eL: -0.08, sRx: -3.05, sRz: 0.18, eR: -0.08, hipL: -1.45, kL: 1.2, hipR: -1.45, kR: 1.2 },
    phoneSit: { py: 0.52, lean: 0.0, hx: 0.42, hy: 0, sLx: 0.27, sLz: -0.2, eL: -2.49, sRx: 0.27, sRz: -0.2, eR: -2.49, hipL: -1.52, kL: 1.48, hipR: -1.52, kR: 1.48 },
    couch:    { py: 0.56, lean: -0.24, hx: 0.38, hy: 0, sLx: -0.62, sLz: -0.06, eL: -1.5, sRx: -0.62, sRz: -0.06, eR: -1.5, hipL: -1.5, kL: 1.5, hipR: -1.5, kR: 1.5 },
    couchBack:{ py: 0.56, lean: -0.3, hx: -0.05, hy: 0, sLx: -0.3, sLz: 0.35, eL: -0.6, sRx: -0.3, sRz: 0.35, eR: -0.6, hipL: -1.5, kL: 1.5, hipR: -1.5, kR: 1.2 },
    brew:     { py: 0.94, lean: 0.12, hx: 0.38, hy: 0, sLx: -0.95, sLz: 0.05, eL: -0.5, sRx: -1.0, sRz: 0.05, eR: -0.45, hipL: 0, kL: 0, hipR: 0, kR: 0 },
    point:    { py: 0.94, lean: 0, hx: -0.05, hy: 0, sLx: 0.12, sLz: 0.2, eL: -0.45, sRx: -1.6, sRz: 0.04, eR: -0.12, hipL: 0, kL: 0, hipR: 0, kR: 0 },
    ready:    { py: 0.88, lean: 0.28, hx: -0.15, hy: 0, sLx: -0.45, sLz: 0.12, eL: -0.9, sRx: -0.7, sRz: 0.15, eR: -0.9, hipL: -0.35, kL: 0.45, hipR: -0.35, kR: 0.45 },
    wave:     { py: 0.52, lean: 0.0, hx: -0.1, hy: 0, sLx: 0.29, sLz: -0.25, eL: -1.41, sRx: -2.9, sRz: 0.35, eR: -0.45, hipL: -1.52, kL: 1.48, hipR: -1.52, kR: 1.48 },
    behindBack: { py: 0.94, lean: 0.0, hx: -0.04, hy: 0, sLx: 0.42, sLz: 0.1, eL: -0.8, sRx: 0.42, sRz: 0.1, eR: -0.8, hipL: 0, kL: 0, hipR: 0, kR: 0 },
    lookOver: { py: 0.94, lean: 0.34, hx: 0.3, hy: 0, sLx: 0.42, sLz: 0.1, eL: -0.8, sRx: 0.42, sRz: 0.1, eR: -0.8, hipL: -0.06, kL: 0.1, hipR: -0.06, kR: 0.1 },
    fridge:   { py: 0.92, lean: 0.18, hx: 0.25, hy: 0, sLx: -0.9, sLz: 0.25, eL: -0.3, sRx: 0.05, sRz: 0.08, eR: -0.2, hipL: -0.1, kL: 0.15, hipR: -0.1, kR: 0.15 }
  };
  const JOINTS = Object.keys(POSE.stand);
  // Lengths of the rig, before a person's height scales it: pelvis to spine, spine to shoulder,
  // shoulder to elbow, elbow to hand.
  const RIG = { spine: 0.04, shoulderY: 0.42, shoulderX: 0.19, upperArm: 0.27, forearm: 0.27 };
  // POSE.type leaves out the arm swing. Everyone reaches a keyboard at the same height, but a
  // figure scales with its height and the desk does not, so each person gets their own angles.
  // The forearms stay level and the back stays upright, which keeps the forearms and elbows clear
  // of the desk's front edge, and the hands stop just above the keys. Heights from 0.8 to 1.1
  // reach the keyboard; outside that the arms go as far as they can and the hands miss it.
  const WRIST_Y = 0.81;
  function typePoseFor(height) {
    const { py, lean } = POSE.type, shoulderY = py + RIG.spine + RIG.shoulderY * Math.cos(lean);
    const swing = Math.acos(Math.max(-1, Math.min(1, (shoulderY - WRIST_Y / height) / RIG.upperArm)));
    const sx = -swing - lean, e = swing - Math.PI / 2;
    return Object.assign({}, POSE.type, { sLx: sx, sRx: sx, eL: e, eR: e });
  }
  // At a desk, each joint turns straight to its new angle, so a hand going between the lap and
  // the keyboard would pass through the desk. So an arm at a desk takes a route instead. Each
  // seated pose keeps a hand in one of three places: in the lap, low and behind the desk's front
  // edge; on the keys, above the desk; or up, high and behind the edge. Going to another place,
  // the arm folds at the elbow, swings at the shoulder, and only then opens out. A folded hand
  // stays close to the shoulder, behind the edge. From the lap and to it, the fold is ARM_LIFT,
  // a hand at the chest with the elbow back, so the hand rises behind the edge as it folds.
  // Heights are from the floor and forward is from the chair's spot, so the desk does not scale.
  const DESK = { top: 0.75, edge: 0.27, hand: 0.05 }, FOLD = -2.5, ARM_LIFT = { sx: 0.5, e: FOLD }, NEAR = 0.2;
  const ARM_HANG = { sLx: POSE.stand.sLx, eL: POSE.stand.eL, sRx: POSE.stand.sRx, eR: POSE.stand.eR };
  // Where a hand is, forward and up, for a pose and a person's height.
  function handAt(p, side, height) {
    const sx = p['s' + side + 'x'], e = p['e' + side];
    const ay = (-RIG.upperArm - RIG.forearm * Math.cos(e)) * Math.cos(p['s' + side + 'z']), az = -RIG.forearm * Math.sin(e);
    const y = RIG.shoulderY + ay * Math.cos(sx) - az * Math.sin(sx), z = ay * Math.sin(sx) + az * Math.cos(sx);
    return [(y * Math.sin(p.lean) + z * Math.cos(p.lean)) * height, (y * Math.cos(p.lean) - z * Math.sin(p.lean) + RIG.spine + p.py) * height];
  }
  // ahead is how far the person is in front of the chair's spot, as they get up or sit down.
  function placeOf(p, side, height, ahead) {
    const [z, y] = handAt(p, side, height), low = y - DESK.hand < DESK.top;
    if (z + ahead + DESK.hand > DESK.edge && !low) return 'keys';
    return low ? 'lap' : 'up';
  }
  // The route for one arm: fold where it is, swing folded, then open out at the target.
  function routeFor(p, t, sx, e, from, to) {
    if (from === to && from !== 'up') return [];
    return [from === 'lap' ? ARM_LIFT : { sx: p[sx], e: FOLD }, to === 'lap' ? ARM_LIFT : { sx: t[sx], e: FOLD }];
  }
  // The pose to aim for this frame: the target, with each arm at the next point of its route.
  // route keeps, per arm, the target it was planned for and the points still ahead.
  function aimArms(route, p, t, height, ahead) {
    if (ahead > 0.03) { delete route.L; delete route.R; return Object.assign({}, t, ARM_HANG); }  // sitting down: the arms hang until they are in the chair
    let aim = t;
    for (const side of ['L', 'R']) {
      const sx = 's' + side + 'x', e = 'e' + side;
      let r = route[side];
      if (!r || r.sx !== t[sx] || r.e !== t[e]) r = route[side] = { sx: t[sx], e: t[e], via: routeFor(p, t, sx, e, placeOf(p, side, height, ahead), placeOf(t, side, height, 0)) };
      while (r.via.length && Math.abs(p[sx] - r.via[0].sx) + Math.abs(p[e] - r.via[0].e) < NEAR) r.via.shift();
      if (!r.via.length) continue;
      if (aim === t) aim = Object.assign({}, t);
      aim[sx] = r.via[0].sx; aim[e] = r.via[0].e;
    }
    return aim;
  }
  // Seated, the mug is held at the chest, behind the desk's front edge.
  const ARM_CARRY = { sRx: -0.28, sRz: 0.08, eR: -1.45 }, ARM_CARRY_SIT = { sRx: 0.27, sRz: 0.08, eR: -2.49 }, ARM_SIP = { sRx: -0.62, sRz: -0.2, eR: -2.38 }, ARM_PADDLE = { sRx: -0.7, sRz: 0.2, eR: -1.0 };
  // Sitting on a seat of a given height (the couch, the armchair). The pelvis rests on the seat, so a
  // person of any height sits on it, not in it, and a knee bends further forward when a foot would
  // go through the floor. Leg lengths are from buildPerson in office/office.js: the hip is 0.02 under
  // the pelvis, the thigh 0.43 long, and the shoe's sole 0.49 from the knee.
  const SEAT = { pelvis: 0.09, hip: 0.02, thigh: 0.43, shin: 0.49 };
  function seatOn(pose, seat, height) {
    const h = height || 1, py = seat / h + SEAT.pelvis, out = { py };
    for (const [hip, knee] of [['hipL', 'kL'], ['hipR', 'kR']]) {
      const kneeY = py - SEAT.hip - SEAT.thigh * Math.cos(pose[hip]);
      const footY = kneeY - SEAT.shin * Math.cos(pose[hip] + pose[knee]);
      out[knee] = footY >= 0 ? pose[knee] : -pose[hip] - Math.acos(Math.min(1, kneeY / SEAT.shin));
    }
    return out;
  }
  // One frame of an arm or a body moving toward its aim. k is how far it goes, from 0 to 1.
  function towards(p, aim, k) { for (const j of JOINTS) p[j] += (aim[j] - p[j]) * k; }
  const api = { POSE, RIG, DESK, SEAT, typePoseFor, aimArms, seatOn, towards, ARM_CARRY, ARM_CARRY_SIT, ARM_SIP, ARM_PADDLE };
  if (typeof module !== 'undefined') module.exports = api; else window.OfficePoses = api;
})();
