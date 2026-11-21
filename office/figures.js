// The figures in the room. Every person and every robot is built on one skeleton, the joints that
// office/poses.js turns: a root scaled to the figure's height, then the pelvis, the spine, the neck
// and the head, two arms of shoulder, elbow and hand, and two legs of hip and knee. A design puts its
// parts on those joints and never moves one, so every pose, seat, prop and party hat fits every
// figure. office/office.js builds people with buildPerson and robots with robot(), both on skeleton().
// edition() says whether the page shows people or robots: ?robots in the address, or edition in
// office/roster.js. See "The robot edition" in docs/manual/how-it-works.html.
// Also loaded with require by relay/test/figures.test.js, which builds every design with three.js.
(function () {
  'use strict';
  const FLAT = [Math.PI / 2, 0, 0], SIDES = ['L', 'R'];

  function skeleton(T, rig, height) {
    const root = new T.Group(); root.scale.setScalar(height || 1);
    const pelvis = new T.Group(); root.add(pelvis); pelvis.position.y = 0.94;
    const spine = new T.Group(); pelvis.add(spine); spine.position.y = rig.spine;
    const neck = new T.Group(); spine.add(neck); neck.position.y = 0.48;
    const head = new T.Group(); neck.add(head); head.position.y = 0.17;
    const arms = {}, hands = {}, legs = {};
    for (const [side, s] of [['L', 1], ['R', -1]]) {
      const sh = new T.Group(); spine.add(sh); sh.position.set(rig.shoulderX * s, rig.shoulderY, 0);
      const el = new T.Group(); sh.add(el); el.position.y = -rig.upperArm;
      const hand = new T.Group(); el.add(hand); hand.position.y = -rig.forearm;
      arms[side] = { sh, el }; hands[side] = hand;
      const hip = new T.Group(); pelvis.add(hip); hip.position.set(0.085 * s, -0.02, 0);
      const knee = new T.Group(); hip.add(knee); knee.position.y = -0.43;
      legs[side] = { hip, knee };
    }
    return { root, pelvis, spine, neck, head, arms, hands, legs };
  }

  function edition(search, roster) {
    const asked = new URLSearchParams(search || '').get('robots');
    if (asked !== null) return asked === 'off' ? 'people' : 'robots';
    return roster && roster.edition === 'robots' ? 'robots' : 'people';
  }

  function withExtras(kit) {
    const T = kit.THREE;
    return Object.assign({}, kit, {
      glow: (hex, strength) => new T.MeshStandardMaterial({ color: kit.C(0x111111), emissive: kit.C(hex), emissiveIntensity: strength || 1.8, roughness: 0.35 }),
      ring: (parent, mat, p, R, r, rot) => {
        const m = kit.mesh(new T.TorusGeometry(R, r, 8, 24), mat, parent); m.position.set(p[0], p[1], p[2]);
        if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
        return m;
      }
    });
  }

  const DESIGNS = {
    tin(k, f, L) {
      const { THREE: T, RIG, std, metal, glow, ball, block, cyl, rod, ring } = k;
      const tin = metal('#c3c7cc', 0.28), red = std('#b5362c', { roughness: 0.32, metalness: 0.3 }), dark = std('#1b1d21', { roughness: 0.5 });
      const brass = metal('#c9a35a', 0.3), eye = glow(L.color, 2.4);
      block(f.pelvis, tin, [0, 0, 0], [0.3, 0.16, 0.2]);
      block(f.spine, red, [0, 0.25, 0], [0.36, 0.42, 0.24]);
      cyl(f.spine, tin, [0, 0.035, 0], 0.13, 0.07).scale.z *= 0.8;
      block(f.spine, dark, [0, 0.28, 0.122], [0.24, 0.22, 0.012]);
      [L.color, '#ffcf5a', '#ff5a4a'].forEach((c, i) => ball(f.spine, glow(c, 1.8), [-0.07 + i * 0.07, 0.34, 0.13], 0.02, [1, 1, 0.6]));
      for (let n = 0; n < 4; n++) block(f.spine, tin, [0, 0.2 + n * 0.025, 0.13], [0.18, 0.008, 0.008]);
      for (const sx of [-1, 1]) for (const y of [0.07, 0.43]) ball(f.spine, tin, [0.16 * sx, y, 0.122], 0.012);
      for (const s of [-1, 1]) rod(f.spine, tin, [0.14 * s, 0.42, 0], [0.245 * s, 0.42, 0], 0.065);
      const key = new T.Group(); key.position.set(0, 0.28, -0.12); f.spine.add(key);
      rod(key, brass, [0, 0, 0], [0, 0, -0.09], 0.014);
      for (const s of [-1, 1]) ball(key, brass, [0.045 * s, 0, -0.09], 0.045, [1, 0.62, 0.22]);
      cyl(f.neck, tin, [0, 0.05, 0], 0.05, 0.1);
      for (const y of [0.025, 0.065]) ring(f.neck, tin, [0, y, 0], 0.052, 0.009, FLAT);
      block(f.head, tin, [0, 0.01, 0], [0.24, 0.22, 0.22]);
      block(f.head, red, [0, 0.13, 0], [0.25, 0.03, 0.23]);
      for (const s of [-1, 1]) {
        ring(f.head, brass, [0.055 * s, 0.03, 0.112], 0.034, 0.008);
        ball(f.head, eye, [0.055 * s, 0.03, 0.108], 0.029, [1, 1, 0.45]);
        rod(f.head, red, [0.12 * s, 0, 0], [0.155 * s, 0, 0], 0.035);
        ball(f.head, tin, [0.16 * s, 0, 0], 0.018);
      }
      block(f.head, dark, [0, -0.05, 0.111], [0.12, 0.04, 0.006]);
      for (let n = -2; n <= 2; n++) block(f.head, tin, [n * 0.022, -0.05, 0.115], [0.008, 0.032, 0.006]);
      rod(f.head, tin, [0, 0.145, 0], [0, 0.25, 0], 0.007);
      ball(f.head, glow('#ff5a4a', 2), [0, 0.262, 0], 0.02);
      for (const side of SIDES) {
        const { sh, el } = f.arms[side], hand = f.hands[side];
        rod(sh, tin, [0, 0, 0], [0, -RIG.upperArm, 0], 0.045);
        for (let n = 1; n <= 3; n++) ring(sh, tin, [0, -n * 0.065, 0], 0.048, 0.011, FLAT);
        ball(el, red, [0, 0, 0], 0.052);
        rod(el, tin, [0, 0, 0], [0, -0.24, 0], 0.041);
        for (let n = 1; n <= 2; n++) ring(el, tin, [0, -n * 0.075, 0], 0.044, 0.01, FLAT);
        ball(hand, dark, [0, 0, 0], 0.038);
        for (const s of [-1, 1]) block(hand, tin, [0, -0.05, 0.022 * s], [0.035, 0.075, 0.018], [-0.3 * s, 0, 0]);
      }
      for (const side of SIDES) {
        const { hip, knee } = f.legs[side];
        rod(hip, tin, [0, 0, 0], [0, -0.43, 0], 0.062);
        ball(knee, red, [0, 0, 0], 0.066);
        cyl(knee, tin, [0, -0.21, 0], 0.066, 0.4, 0.056);
        block(knee, red, [0, -0.45, 0.045], [0.13, 0.07, 0.27]);
        block(knee, tin, [0, -0.475, 0.045], [0.136, 0.03, 0.276]);
      }
      return { hatTop: 0.145, tick: (dt, how) => { if (!how.still) key.rotation.z += dt * 1.4; } };
    }
  };

  function robot(kit, look) {
    const k = withExtras(kit), L = Object.assign({ height: 1, color: '#9fd3ff' }, look || {});
    const f = skeleton(k.THREE, k.RIG, L.height);
    const design = Object.prototype.hasOwnProperty.call(DESIGNS, L.design) ? L.design : 'tin';
    const extra = DESIGNS[design](k, f, L) || {};
    f.design = design; f.hatTop = extra.hatTop; f.tick = extra.tick || null;
    f.root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    return f;
  }

  const api = { skeleton, edition, robot, DESIGNS: Object.keys(DESIGNS) };
  if (typeof module !== 'undefined') module.exports = api;
  else window.OfficeFigures = api;
})();
