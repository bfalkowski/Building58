// The figures in the room. Every person and every robot is built on one skeleton, the joints that
// office/poses.js turns: a root scaled to the figure's height, then the pelvis, the spine, the neck
// and the head, two arms of shoulder, elbow and hand, and two legs of hip and knee. A design puts its
// parts on those joints and never moves one, so every pose, seat, prop and party hat fits every
// figure. office/office.js builds people with buildPerson and robots with robot(), both on skeleton().
// An edition is a way the room can look, named in `editions` in office/roster.js. edition() picks the
// one the page shows: ?edition=<name> in the address, else the roster's `edition`, else people.
// deskFigure() says how an edition draws a desk's person: as a robot (figure: 'robot'), or as the
// person in the roster. A robot edition's `designs` give each desk's design by its id: tin, tty,
// visor, ilium or pebble. Each design shows the desk's color in a light, and tick() gets the
// figure's mood (work, wait, couch, party or idle) and whether motion is reduced, for its screens
// and lights. managerLook() gives the manager his look in an edition: its `manager`, or his own
// look. See "Editions" in docs/manual/how-it-works.html.
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

  function editionOf(roster, name) {
    const all = roster && roster.editions;
    return all && typeof name === 'string' && Object.prototype.hasOwnProperty.call(all, name) ? all[name] : null;
  }

  function edition(search, roster) {
    const known = (name) => name === 'people' || !!editionOf(roster, name);
    const asked = new URLSearchParams(search || '').get('edition');
    if (asked !== null && known(asked)) return asked;
    return roster && known(roster.edition) ? roster.edition : 'people';
  }

  function managerLook(roster, name) {
    const e = editionOf(roster, name);
    return (e && e.manager) || ((roster && roster.manager) || {}).look;
  }

  function deskFigure(roster, name, def) {
    const e = editionOf(roster, name), d = def || {};
    if (!e || e.figure !== 'robot') return null;
    return { design: (e.designs || {})[d.id], height: (d.look || {}).height || 1, color: d.color || '#9fd3ff' };
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
    },

    tty(k, f, L) {
      const { THREE: T, RIG, std, glow, mesh, ball, block, cyl, rod, ring, makeCanvas, tex } = k;
      const beige = std('#d8cdb4', { roughness: 0.62 }), beige2 = std('#c4b89c', { roughness: 0.66 }), dark = std('#2a2c30', { roughness: 0.5 }), cable = std('#34373c', { roughness: 0.75 });
      block(f.pelvis, dark, [0, 0, 0], [0.28, 0.15, 0.19]);
      block(f.spine, beige, [0, 0.25, 0], [0.34, 0.44, 0.22]);
      block(f.spine, beige2, [0.03, 0.35, 0.111], [0.2, 0.055, 0.006]);
      block(f.spine, dark, [0.03, 0.35, 0.115], [0.15, 0.012, 0.004]);
      ball(f.spine, glow(L.color, 2.4), [-0.12, 0.35, 0.113], 0.012);
      for (let n = 0; n < 5; n++) block(f.spine, beige2, [0, 0.1 + n * 0.03, 0.111], [0.24, 0.011, 0.005]);
      for (const s of [-1, 1]) block(f.spine, beige2, [0.17 * s, 0.415, 0], [0.11, 0.08, 0.17]);
      cyl(f.neck, cable, [0, 0.045, 0], 0.035, 0.09);
      cyl(f.neck, beige2, [0, 0.085, 0], 0.075, 0.02);
      block(f.head, beige, [0, 0.01, 0.02], [0.27, 0.22, 0.16]);
      block(f.head, beige2, [0, 0, -0.085], [0.2, 0.16, 0.08]);
      block(f.head, dark, [0, 0.02, 0.1], [0.225, 0.165, 0.01]);
      for (const s of [-1, 1]) ball(f.head, dark, [0.1 * s, -0.08, 0.1], 0.011);
      const sc = makeCanvas(200, 150), st = tex(sc);
      const face = mesh(new T.PlaneGeometry(0.205, 0.152), new T.MeshBasicMaterial({ map: st, toneMapped: false }), f.head, false);
      face.position.set(0, 0.02, 0.1056);
      for (const side of SIDES) {
        const { sh, el } = f.arms[side], hand = f.hands[side];
        ball(sh, beige2, [0, 0, 0], 0.055);
        rod(sh, cable, [0, 0, 0], [0, -RIG.upperArm, 0], 0.034);
        for (let n = 1; n <= 4; n++) ring(sh, cable, [0, -n * 0.05, 0], 0.037, 0.007, FLAT);
        ball(el, beige, [0, 0, 0], 0.048);
        rod(el, cable, [0, 0, 0], [0, -0.24, 0], 0.032);
        for (let n = 1; n <= 3; n++) ring(el, cable, [0, -n * 0.055, 0], 0.035, 0.007, FLAT);
        block(hand, beige, [0, -0.025, 0], [0.075, 0.1, 0.05]);
        block(hand, beige2, [0, -0.01, 0.035], [0.03, 0.05, 0.025]);
      }
      for (const side of SIDES) {
        const { hip, knee } = f.legs[side];
        block(hip, beige, [0, -0.2, 0], [0.12, 0.38, 0.13]);
        ball(knee, dark, [0, 0, 0], 0.06);
        block(knee, beige, [0, -0.21, 0], [0.11, 0.36, 0.12]);
        block(knee, dark, [0, -0.455, 0.045], [0.12, 0.07, 0.26]);
      }
      let t = 0, drawn = '';
      function draw(mood, still) {
        const x = sc.getContext('2d'), on = still || Math.floor(t * 2) % 2 === 0;
        x.shadowBlur = 0; x.globalAlpha = 1; x.fillStyle = '#0c120e'; x.fillRect(0, 0, 200, 150);
        x.fillStyle = L.color; x.shadowColor = L.color; x.shadowBlur = 7;
        if (mood === 'work') {
          const top = still ? 0 : Math.floor(t * 3);
          for (let i = 0; i < 6; i++) { const n = top + i; x.globalAlpha = n % 4 ? 0.75 : 1; x.fillRect(16 + (n * 7 % 3) * 12, 14 + i * 19, 34 + (n * 37 % 104), 8); }
          x.globalAlpha = 1; if (on) x.fillRect(16, 128, 12, 9);
        } else {
          const blink = !still && t % 4.3 < 0.14;
          if (mood === 'couch' || mood === 'party') { x.fillRect(46, 62, 36, 9); x.fillRect(118, 62, 36, 9); }
          else if (blink) { x.fillRect(50, 64, 30, 6); x.fillRect(120, 64, 30, 6); }
          else if (mood === 'wait') { x.fillRect(48, 34, 34, 50); x.fillRect(118, 34, 34, 50); }
          else { x.fillRect(52, 40, 26, 42); x.fillRect(122, 40, 26, 42); }
          x.font = '700 30px monospace'; x.textBaseline = 'middle';
          x.fillText(mood === 'wait' ? '?' : '>', 64, 117); if (on) x.fillRect(90, 124, 22, 6);
        }
        x.shadowBlur = 0; x.globalAlpha = 1; x.fillStyle = 'rgba(0,0,0,0.28)';
        for (let y = 0; y < 150; y += 3) x.fillRect(0, y, 200, 1);
        st.needsUpdate = true;
      }
      draw('idle', true);
      return {
        hatTop: 0.125,
        tick: (dt, how) => {
          t += dt;
          const key = how.mood + (how.still ? '' : ':' + Math.floor(t * 6));
          if (key !== drawn) { drawn = key; draw(how.mood, how.still); }
        }
      };
    },

    visor(k, f, L) {
      const { THREE: T, std, glow, mesh, ball, block, cyl, rod } = k;
      const shell = std('#eceef1', { roughness: 0.26, metalness: 0.05 }), joint = std('#2a2e35', { roughness: 0.42, metalness: 0.35 });
      const gloss = std('#0b0d11', { roughness: 0.08, metalness: 0.5 }), acc = glow(L.color, 2.6);
      ball(f.pelvis, shell, [0, 0, 0], 0.16, [1.0, 0.55, 0.72]);
      for (let n = 0; n < 3; n++) cyl(f.spine, joint, [0, 0.02 + n * 0.045, 0], 0.115 - n * 0.004, 0.035).scale.z *= 0.72;
      const chest = mesh(new T.CylinderGeometry(0.18, 0.135, 0.3, 28), shell, f.spine); chest.position.y = 0.29; chest.scale.z = 0.68;
      ball(f.spine, shell, [0, 0.43, 0], 0.18, [1.12, 0.4, 0.66]);
      ball(f.spine, gloss, [0, 0.32, 0.1], 0.045, [1, 1, 0.35]);
      ball(f.spine, acc, [0, 0.32, 0.112], 0.022, [1, 1, 0.4]);
      block(f.spine, joint, [0, 0.27, -0.1], [0.04, 0.3, 0.03]);
      for (const s of [-1, 1]) ball(f.spine, joint, [0.19 * s, 0.42, 0], 0.056);
      cyl(f.neck, joint, [0, 0.05, 0], 0.04, 0.12);
      ball(f.head, shell, [0, 0.005, 0], 0.112, [0.92, 1.08, 1.0]);
      ball(f.head, gloss, [0, 0.012, 0.03], 0.098, [0.94, 0.56, 0.88]);
      const band = mesh(new T.TorusGeometry(0.09, 0.0065, 8, 40, Math.PI), acc, f.head, false);
      band.rotation.x = Math.PI / 2; band.position.set(0, 0.012, 0.028);
      for (const s of [-1, 1]) rod(f.head, joint, [0.09 * s, 0, -0.005], [0.112 * s, 0, -0.005], 0.03);
      for (const side of SIDES) {
        const { sh, el } = f.arms[side], hand = f.hands[side];
        const up = mesh(new T.CylinderGeometry(0.05, 0.042, 0.22, 18), shell, sh); up.position.y = -0.125;
        ball(el, joint, [0, 0, 0], 0.044);
        const fo = mesh(new T.CylinderGeometry(0.045, 0.035, 0.21, 18), shell, el); fo.position.y = -0.12;
        block(el, acc, [0, -0.12, 0.038], [0.012, 0.13, 0.014]);
        ball(hand, joint, [0, 0, 0], 0.036, [0.85, 1, 0.7]);
        block(hand, joint, [0, -0.05, 0.006], [0.058, 0.055, 0.022]);
        block(hand, joint, [0, -0.02, 0.03], [0.02, 0.04, 0.02]);
      }
      for (const side of SIDES) {
        const { hip, knee } = f.legs[side];
        ball(hip, joint, [0, 0, 0], 0.07);
        const th = mesh(new T.CylinderGeometry(0.078, 0.06, 0.34, 18), shell, hip); th.position.y = -0.2;
        ball(knee, joint, [0, 0, 0], 0.056);
        const sn = mesh(new T.CylinderGeometry(0.062, 0.045, 0.34, 18), shell, knee); sn.position.y = -0.2;
        ball(knee, joint, [0, -0.4, 0], 0.04);
        block(knee, joint, [0, -0.462, 0.04], [0.1, 0.055, 0.24]);
        block(knee, shell, [0, -0.455, 0.13], [0.102, 0.06, 0.07]);
      }
      let t = 0;
      return { hatTop: 0.13, tick: (dt, how) => { t += dt; acc.emissiveIntensity = how.still ? 2.4 : 2.2 + Math.sin(t * 1.7) * 0.5; } };
    },

    ilium(k, f, L) {
      const { THREE: T, RIG, std, metal, glow, mesh, ball, block, cyl, rod, makeCanvas, tex } = k;
      const paint = std('#e1a91d', { roughness: 0.5, metalness: 0.25 }), steel = metal('#50545b', 0.45), chrome = metal('#d7dade', 0.16);
      const black = std('#17181a', { roughness: 0.6 }), acc = glow(L.color, 2.6);
      const hz = makeCanvas(256, 32), hx = hz.getContext('2d');
      hx.fillStyle = '#e1a91d'; hx.fillRect(0, 0, 256, 32); hx.fillStyle = '#17181a';
      for (let i = -2; i < 10; i++) { hx.beginPath(); hx.moveTo(i * 32, 32); hx.lineTo(i * 32 + 16, 32); hx.lineTo(i * 32 + 48, 0); hx.lineTo(i * 32 + 32, 0); hx.closePath(); hx.fill(); }
      const hazard = new T.MeshStandardMaterial({ map: tex(hz), roughness: 0.55, metalness: 0.2 });
      const plate = makeCanvas(256, 80), px = plate.getContext('2d');
      px.fillStyle = L.color; px.fillRect(0, 0, 256, 80);
      px.fillStyle = '#17181a'; px.fillRect(0, 0, 256, 7); px.fillRect(0, 73, 256, 7);
      px.font = '700 46px monospace'; px.textAlign = 'center'; px.textBaseline = 'middle'; px.fillText('IW-7', 128, 42);
      block(f.pelvis, steel, [0, 0, 0], [0.3, 0.15, 0.2]);
      block(f.pelvis, hazard, [0, 0, 0.101], [0.3, 0.05, 0.004]);
      block(f.spine, steel, [0, 0.07, 0], [0.24, 0.12, 0.17]);
      block(f.spine, paint, [0, 0.29, 0], [0.38, 0.34, 0.25]);
      block(f.spine, hazard, [0, 0.145, 0.127], [0.38, 0.045, 0.004]);
      const id = mesh(new T.PlaneGeometry(0.24, 0.075), new T.MeshStandardMaterial({ map: tex(plate), roughness: 0.5 }), f.spine, false); id.position.set(0, 0.31, 0.1256);
      for (const s of [-1, 1]) block(f.spine, paint, [0.2 * s, 0.45, 0], [0.15, 0.07, 0.22], [0, 0, -0.22 * s]);
      for (const s of [-1, 1]) { cyl(f.spine, steel, [0.08 * s, 0.38, -0.15], 0.028, 0.2); cyl(f.spine, black, [0.08 * s, 0.485, -0.15], 0.032, 0.02); }
      for (const y of [0.22, 0.38]) for (const s of [-1, 1]) ball(f.spine, steel, [0.17 * s, y, 0.127], 0.01);
      cyl(f.neck, steel, [0, 0.05, 0], 0.05, 0.1);
      block(f.head, paint, [0, 0.01, 0], [0.22, 0.19, 0.22]);
      block(f.head, black, [0, 0.025, 0.106], [0.18, 0.075, 0.02]);
      block(f.head, hazard, [0, -0.07, 0.1105], [0.22, 0.03, 0.002]);
      rod(f.head, steel, [0, 0.025, 0.1], [0, 0.025, 0.14], 0.032);
      ball(f.head, std('#0b0c0e', { roughness: 0.05, metalness: 0.6 }), [0, 0.025, 0.14], 0.026, [1, 1, 0.55]);
      ball(f.head, acc, [0, 0.025, 0.152], 0.011);
      for (const s of [-1, 1]) { ball(f.head, glow('#fff1d6', 1.2), [0.07 * s, 0.025, 0.117], 0.011); block(f.head, steel, [0.118 * s, 0, 0], [0.02, 0.11, 0.13]); }
      cyl(f.head, steel, [0, 0.115, 0], 0.035, 0.02);
      const beacon = ball(f.head, glow('#ff8a2a', 1.8), [0, 0.14, 0], 0.03, [1, 0.9, 1]);
      for (const side of SIDES) {
        const { sh, el } = f.arms[side], hand = f.hands[side];
        ball(sh, steel, [0, 0, 0], 0.055);
        rod(sh, steel, [0, 0, 0], [0, -RIG.upperArm, 0], 0.03);
        block(sh, paint, [0, -0.13, 0.005], [0.1, 0.17, 0.1]);
        rod(sh, chrome, [0, -0.04, -0.065], [0, -0.24, -0.065], 0.011);
        cyl(sh, black, [0, -0.08, -0.065], 0.019, 0.09);
        rod(el, steel, [-0.055, 0, 0], [0.055, 0, 0], 0.045);
        block(el, paint, [0, -0.13, 0], [0.09, 0.19, 0.09]);
        cyl(el, steel, [0, -0.24, 0], 0.04, 0.03);
        block(hand, steel, [0, -0.005, 0], [0.08, 0.045, 0.07]);
        for (const x of [-0.025, 0.025]) block(hand, black, [x, -0.06, 0.018], [0.018, 0.07, 0.018]);
        block(hand, black, [0, -0.055, -0.025], [0.02, 0.06, 0.018]);
      }
      for (const side of SIDES) {
        const { hip, knee } = f.legs[side];
        ball(hip, steel, [0, 0, 0], 0.06);
        rod(hip, steel, [0, 0, 0], [0, -0.43, 0], 0.04);
        block(hip, paint, [0, -0.2, 0.012], [0.13, 0.28, 0.13]);
        rod(hip, chrome, [0, -0.06, -0.075], [0, -0.38, -0.075], 0.012);
        cyl(hip, black, [0, -0.12, -0.075], 0.02, 0.1);
        rod(knee, steel, [-0.068, 0, 0], [0.068, 0, 0], 0.05);
        block(knee, paint, [0, 0, 0.055], [0.1, 0.08, 0.03]);
        block(knee, paint, [0, -0.2, 0], [0.12, 0.3, 0.12]);
        cyl(knee, steel, [0, -0.375, 0], 0.045, 0.05);
        block(knee, steel, [0, -0.455, 0.045], [0.14, 0.07, 0.28]);
        block(knee, hazard, [0, -0.455, 0.186], [0.14, 0.05, 0.002]);
      }
      let t = 0;
      return { hatTop: 0.17, tick: (dt, how) => { t += dt; beacon.material.emissiveIntensity = how.still ? 1.8 : 1.1 + Math.max(0, Math.sin(t * 4)) * 2; } };
    },

    pebble(k, f, L) {
      const { THREE: T, std, glow, mesh, ball, cyl, rod, makeCanvas, tex } = k;
      const tint = '#' + new T.Color(L.color).lerp(new T.Color('#ffffff'), 0.22).getHexString();
      const eyes = '#' + new T.Color(L.color).lerp(new T.Color('#ffffff'), 0.5).getHexString();
      const shell = std(tint, { roughness: 0.78 }), white = std('#f4f1ea', { roughness: 0.6 }), joint = std('#3a3b42', { roughness: 0.6 });
      ball(f.pelvis, shell, [0, 0, 0], 0.168, [1.0, 0.62, 0.76]);
      const prof = [[0, 0], [0.12, 0], [0.155, 0.06], [0.17, 0.18], [0.168, 0.3], [0.15, 0.4], [0.1, 0.46], [0, 0.48]].map(([r, y]) => new T.Vector2(r, y));
      const body = mesh(new T.LatheGeometry(prof, 32), shell, f.spine); body.scale.z = 0.74;
      ball(f.spine, white, [0, 0.22, 0.088], 0.1, [1, 1.25, 0.42]);
      cyl(f.neck, joint, [0, 0.04, 0], 0.042, 0.08);
      ball(f.head, white, [0, 0.02, 0], 0.13, [1.15, 0.95, 0.95]);
      const fc = makeCanvas(288, 160), ft = tex(fc);
      const screen = mesh(new T.SphereGeometry(0.1318, 32, 16, Math.PI / 2 - 0.75, 1.5, Math.PI / 2 - 0.5, 1.0), new T.MeshBasicMaterial({ map: ft, toneMapped: false }), f.head, false);
      screen.position.set(0, 0.02, 0); screen.scale.set(1.15, 0.95, 0.95);
      for (const s of [-1, 1]) rod(f.head, shell, [0.135 * s, 0.02, 0], [0.166 * s, 0.02, 0], 0.045);
      rod(f.head, joint, [0, 0.13, 0], [0, 0.19, -0.01], 0.006);
      ball(f.head, glow(L.color, 2.2), [0, 0.196, -0.012], 0.022);
      for (const side of SIDES) {
        const { sh, el } = f.arms[side], hand = f.hands[side];
        ball(sh, shell, [0, 0, 0], 0.058);
        rod(sh, shell, [0, 0, 0], [0, -0.25, 0], 0.052);
        ball(el, shell, [0, 0, 0], 0.052);
        rod(el, shell, [0, 0, 0], [0, -0.23, 0], 0.048);
        ball(hand, white, [0, -0.01, 0], 0.056, [0.85, 1.05, 0.72]);
      }
      for (const side of SIDES) {
        const { hip, knee } = f.legs[side];
        rod(hip, shell, [0, 0, 0], [0, -0.43, 0], 0.074);
        ball(knee, shell, [0, 0, 0], 0.07);
        rod(knee, shell, [0, 0, 0], [0, -0.4, 0], 0.066);
        ball(knee, white, [0, -0.452, 0.05], 0.1, [0.62, 0.4, 1.3]);
      }
      function pill(x, l, top, w, h, r) {
        x.beginPath(); x.moveTo(l + r, top); x.arcTo(l + w, top, l + w, top + h, r); x.arcTo(l + w, top + h, l, top + h, r);
        x.arcTo(l, top + h, l, top, r); x.arcTo(l, top, l + w, top, r); x.closePath(); x.fill();
      }
      let t = 0, drawn = '';
      function draw(mood, still) {
        const x = fc.getContext('2d'), Ls = 104, Rs = 184, Y = 80, blink = !still && (t + 1.3) % 3.7 < 0.14;
        x.shadowBlur = 0; x.fillStyle = '#0f1216'; x.fillRect(0, 0, 288, 160);
        x.fillStyle = eyes; x.strokeStyle = eyes; x.lineCap = 'round'; x.shadowColor = L.color; x.shadowBlur = 14;
        if (mood === 'couch' || mood === 'party') { x.lineWidth = 11; for (const c of [Ls, Rs]) { x.beginPath(); x.arc(c, Y + 12, 19, Math.PI * 1.15, Math.PI * 1.85); x.stroke(); } }
        else if (blink) { x.lineWidth = 8; for (const c of [Ls, Rs]) { x.beginPath(); x.moveTo(c - 15, Y); x.lineTo(c + 15, Y); x.stroke(); } }
        else if (mood === 'work') { const look = still ? 0 : Math.sin(t * 0.9) * 8; for (const c of [Ls, Rs]) pill(x, c - 16 + look, Y - 3, 32, 15, 7); }
        else if (mood === 'wait') { for (const c of [Ls, Rs]) pill(x, c - 18, Y - 26, 36, 52, 18); }
        else for (const c of [Ls, Rs]) pill(x, c - 14, Y - 22, 28, 44, 14);
        ft.needsUpdate = true;
      }
      draw('idle', true);
      return {
        hatTop: 0.15,
        tick: (dt, how) => {
          t += dt;
          const key = how.mood + (how.still ? '' : ':' + Math.floor(t * 10));
          if (key !== drawn) { drawn = key; draw(how.mood, how.still); }
        }
      };
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

  const api = { skeleton, edition, deskFigure, managerLook, robot, DESIGNS: Object.keys(DESIGNS) };
  if (typeof module !== 'undefined') module.exports = api;
  else window.OfficeFigures = api;
})();
