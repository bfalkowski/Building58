// The office: a loft in New York where each developer is a skill of a coding agent.
// When the agent uses a skill, that developer goes to their desk and works, and the agent's
// tool calls show on their monitor. When nobody needs them, they make coffee, sit on the
// couch, look out of the window or play ping pong.
// The world is driven through window.run, the contract every world page keeps, so the relay
// (../shared/relay.js and relay/server.js) works with it unchanged. See docs/manual/.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const ROSTER = window.OFFICE_ROSTER;
  const canvas = $('world'), stage = $('stage'), tagLayer = $('tags');
  const params = new URLSearchParams(location.search);
  const reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (!window.THREE || !ROSTER) { $('fallback').hidden = false; return; }

  // ---------- renderer, scene, camera ----------
  let renderer = null;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); } catch (e) { renderer = null; }
  if (!renderer) { canvas.hidden = true; $('fallback').hidden = false; }
  else {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  const scene = new THREE.Scene();
  const VOID = 0x0c0f14;
  scene.background = new THREE.Color(VOID);
  scene.fog = new THREE.Fog(VOID, 26, 52);

  const camera = new THREE.PerspectiveCamera(34, 16 / 10, 0.1, 120);
  const HOME = new THREE.Vector3(9.6, 8.4, 12.2), START = new THREE.Vector3(15, 14, 20);
  const TARGET = new THREE.Vector3(-0.2, 0.6, -0.2);
  camera.position.copy(reduce ? HOME : START);
  let controls = null;
  if (renderer && THREE.OrbitControls) {
    controls = new THREE.OrbitControls(camera, canvas);
    controls.target.copy(TARGET);
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.minDistance = 3; controls.maxDistance = 26;
    controls.minPolarAngle = 0.3; controls.maxPolarAngle = 1.4;
    controls.minAzimuthAngle = -0.15; controls.maxAzimuthAngle = 1.6;
    controls.screenSpacePanning = false;
  } else camera.lookAt(TARGET);
  let introCam = !reduce && !!controls, follow = null;
  const VIEWS = {
    home: [HOME, TARGET],
    desks: [new THREE.Vector3(1.6, 3.2, 4.6), new THREE.Vector3(-0.9, 0.9, -1.0)],
    lead: [new THREE.Vector3(-2.6, 2.2, 1.6), new THREE.Vector3(-5.9, 0.95, -0.7)],
    coffee: [new THREE.Vector3(5.6, 2.4, 0.6), new THREE.Vector3(5.0, 1.0, -3.6)],
    lounge: [new THREE.Vector3(6.0, 2.5, 5.9), new THREE.Vector3(5.2, 0.7, 1.5)],
    board: [new THREE.Vector3(0.6, 2.4, -0.6), new THREE.Vector3(-0.95, 1.8, -4.9)]
  };
  function setView(name) {
    const v = VIEWS[name] || VIEWS.home; introCam = false; follow = null;
    camera.position.copy(v[0]); if (controls) { controls.target.copy(v[1]); controls.update(); } else camera.lookAt(v[1]);
    return name in VIEWS ? name : 'home';
  }
  if (controls) controls.addEventListener('start', () => { introCam = false; follow = null; });
  // The on-screen pad for turning and zooming (shared/nav.js). Home is the same as the home view.
  if (controls && window.NavPad) window.NavPad.attach({ stage, canvas, controls, camera, home: () => setView('home') });

  // ---------- helpers ----------
  const C = (hex) => new THREE.Color(hex).convertSRGBToLinear();
  const std = (hex, o) => new THREE.MeshStandardMaterial(Object.assign({ color: C(hex), roughness: 0.7, metalness: 0 }, o || {}));
  const metal = (hex, r) => std(hex, { metalness: 0.75, roughness: r == null ? 0.35 : r });
  const UP = new THREE.Vector3(0, 1, 0);
  const G = { sph: new THREE.SphereGeometry(1, 22, 16), cyl: new THREE.CylinderGeometry(1, 1, 1, 20), box: new THREE.BoxGeometry(1, 1, 1) };
  function mesh(geo, mat, parent, shadow) {
    const m = new THREE.Mesh(geo, mat); m.castShadow = shadow !== false; m.receiveShadow = true;
    if (parent) parent.add(m); return m;
  }
  function ball(parent, mat, p, r, s) {
    const m = mesh(G.sph, mat, parent); m.position.set(p[0], p[1], p[2]);
    m.scale.set(r * (s ? s[0] : 1), r * (s ? s[1] : 1), r * (s ? s[2] : 1)); return m;
  }
  function block(parent, mat, p, size, rot) {
    const m = mesh(G.box, mat, parent); m.position.set(p[0], p[1], p[2]); m.scale.set(size[0], size[1], size[2]);
    if (rot) m.rotation.set(rot[0], rot[1], rot[2]); return m;
  }
  function cyl(parent, mat, p, r, h, rTop) {
    const m = mesh(rTop != null ? new THREE.CylinderGeometry(rTop, r, h, 22) : G.cyl, mat, parent);
    m.position.set(p[0], p[1], p[2]); if (rTop == null) m.scale.set(r, h, r); return m;
  }
  function rod(parent, mat, a, b, r) {
    const A = new THREE.Vector3(a[0], a[1], a[2]), B = new THREE.Vector3(b[0], b[1], b[2]);
    const d = B.clone().sub(A), len = d.length();
    const m = mesh(G.cyl, mat, parent);
    m.position.copy(A).add(B).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(UP, d.normalize()); m.scale.set(r, len, r); return m;
  }
  function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function tex(c, repeat) {
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding;
    if (renderer) t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
    return t;
  }
  function rnd(seed) { let s = seed >>> 0 || 1; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  function angDiff(a, b) { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; }
  const hexRGB = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

  // ---------- time of day: from the real clock, or ?time=day|evening|night ----------
  const PARTS = {
    day:     { sky: ['#8fbfe6', '#e2eef5'], haze: '#c9dbe6', hemi: [0xf2f5ff, 0x8a7560, 1.25], sun: [0xfff3df, 2.0], fill: 0.75, amb: 0.35, lamps: 0.15, exposure: 1.0, lit: 0.06, bldg: ['#7d8da0', '#5f6f82', '#3f4a58'] },
    evening: { sky: ['#283a6e', '#f0955a'], haze: '#d58a6a', hemi: [0xffe0c4, 0x5a4636, 0.8], sun: [0xffa45c, 1.6], fill: 0.45, amb: 0.25, lamps: 1.0, exposure: 1.05, lit: 0.45, bldg: ['#5b4f66', '#3f3a52', '#262636'] },
    night:   { sky: ['#060a17', '#1a2442'], haze: '#22304f', hemi: [0x9fb2d8, 0x3a3028, 0.45], sun: [0x9fb6ff, 0.35], fill: 0.22, amb: 0.18, lamps: 1.9, exposure: 1.12, lit: 0.72, bldg: ['#1b2235', '#141a2a', '#0c111d'] }
  };
  function partNow() {
    const forced = params.get('time');
    if (PARTS[forced]) return forced;
    const h = new Date().getHours();
    return h >= 7 && h < 17 ? 'day' : h >= 17 && h < 20 ? 'evening' : 'night';
  }
  let part = partNow();

  // ---------- lights ----------
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6); scene.add(hemi);
  const amb = new THREE.AmbientLight(0xfff4e6, 0.3); scene.add(amb);
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(-11, 9.5, 2.5); sun.target.position.set(-1, 0, 0); scene.add(sun.target);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 8, bottom: -8, near: 1, far: 30 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xfff1e0, 0.3); fill.position.set(8, 6, 9); scene.add(fill);
  const lamps = [];
  function lampLight(x, y, z, dist) { const l = new THREE.PointLight(C(0xffc98a), 1, dist || 7, 2); l.position.set(x, y, z); scene.add(l); lamps.push(l); return l; }

  // ---------- the void under the loft ----------
  const grid = new THREE.GridHelper(80, 160, C(0x1d4357), C(0x14232d)); grid.position.y = -0.3; scene.add(grid);
  const slab = block(scene, std(0x1d1a18, { roughness: 0.95 }), [0, -0.165, 0], [14.6, 0.3, 10.6]); slab.castShadow = false;  // top just under the floor, so the two never fight

  // ---------- textures ----------
  function brickCanvases() {
    const W = 768, H = 240, BW = 64, BH = 24, M = 4, r = rnd(7);
    const c = makeCanvas(W, H), x = c.getContext('2d'), b = makeCanvas(W, H), y = b.getContext('2d');
    x.fillStyle = '#b3a797'; x.fillRect(0, 0, W, H); y.fillStyle = '#000'; y.fillRect(0, 0, W, H);
    const tones = ['#8a3b2a', '#9b4632', '#7b3426', '#a5543a', '#6e2f22', '#93422f', '#82392a', '#a04a33'];
    for (let row = 0; row < H / BH; row++) {
      const off = row % 2 ? BW / 2 : 0;
      for (let col = -1; col <= W / BW; col++) {
        const bx = col * BW + off, by = row * BH;
        let tone = tones[Math.floor(r() * tones.length)];
        if (r() < 0.05) tone = '#b8866a';
        if (r() < 0.04) tone = '#5a271c';
        x.fillStyle = tone; x.fillRect(bx + M / 2, by + M / 2, BW - M, BH - M);
        for (let k = 0; k < 26; k++) {  // speckles and wear
          x.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.12)' : 'rgba(255,230,210,0.08)';
          x.fillRect(bx + M / 2 + r() * (BW - M - 3), by + M / 2 + r() * (BH - M - 2), 1 + r() * 4, 1 + r() * 2);
        }
        if (r() < 0.12) { x.fillStyle = 'rgba(240,235,225,0.18)'; x.fillRect(bx + M / 2, by + M / 2, (BW - M) * r(), BH - M); }  // old paint
        y.fillStyle = '#fff'; y.fillRect(bx + M / 2 + 1, by + M / 2 + 1, BW - M - 2, BH - M - 2);
      }
    }
    return { color: c, bump: b, tileW: 12 * 0.215, tileH: 10 * 0.075 };
  }
  const BRICK = brickCanvases();
  const brickColorTex = tex(BRICK.color), brickBumpTex = new THREE.CanvasTexture(BRICK.bump);
  function brickMat(w, h) {
    const c = brickColorTex.clone(), b = brickBumpTex.clone();
    for (const t of [c, b]) { t.needsUpdate = true; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(w / BRICK.tileW, h / BRICK.tileH); }
    return new THREE.MeshStandardMaterial({ map: c, bumpMap: b, bumpScale: 0.025, roughness: 0.92, color: 0xffffff });
  }
  function floorTex() {
    const S = 1024, c = makeCanvas(S, S), x = c.getContext('2d'), r = rnd(21), PH = 64;
    const tones = ['#c4925f', '#b98656', '#cd9d6b', '#b07c4e', '#c08d5d', '#a9764a'];
    for (let row = 0; row < S / PH; row++) {
      let px = -r() * 300;
      while (px < S) {
        const len = 260 + r() * 420;
        x.fillStyle = tones[Math.floor(r() * tones.length)]; x.fillRect(px, row * PH, len, PH);
        for (let g = 0; g < 7; g++) {
          x.strokeStyle = 'rgba(60,35,20,' + (0.06 + r() * 0.1) + ')'; x.lineWidth = 1 + r() * 1.5; x.beginPath();
          const gy = row * PH + 6 + r() * (PH - 12); x.moveTo(px, gy);
          x.bezierCurveTo(px + len * 0.3, gy + (r() - 0.5) * 8, px + len * 0.7, gy + (r() - 0.5) * 8, px + len, gy + (r() - 0.5) * 4); x.stroke();
        }
        x.fillStyle = 'rgba(40,25,15,0.55)'; x.fillRect(px, row * PH, 2, PH);
        px += len;
      }
      x.fillStyle = 'rgba(40,25,15,0.6)'; x.fillRect(0, row * PH, S, 2);
    }
    return tex(c, [14 / 2.4, 10 / 2.4]);
  }

  // ---------- the room: 14 x 10 m, back wall at z = -5, windows on the left at x = -7 ----------
  const ROOM = { x0: -7, x1: 7, z0: -5, z1: 5, h: 4.6 };
  const floor = mesh(new THREE.PlaneGeometry(14, 10), new THREE.MeshStandardMaterial({ map: floorTex(), roughness: 0.62 }), scene, false);
  floor.rotation.x = -Math.PI / 2;
  const capMat = std(0x2a2522, { roughness: 0.9 });
  function wallBox(x0, x1, y0, y1, z0, z1, faceW, faceH) {
    const m = brickMat(faceW, faceH);
    const b = mesh(G.box, [m, m, capMat, capMat, m, m], scene);
    b.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2); b.scale.set(x1 - x0, y1 - y0, z1 - z0); return b;
  }
  wallBox(-7.3, 7.0, 0, ROOM.h, -5.3, -5.0, 14.3, ROOM.h);  // back wall
  const WIN = [[-4.1, -1.9], [-1.1, 1.1], [1.9, 4.1]], WY0 = 0.9, WY1 = 3.9;
  wallBox(-7.3, -7.0, 0, WY0, -5.3, 5.0, 10.3, WY0);
  wallBox(-7.3, -7.0, WY1, ROOM.h, -5.3, 5.0, 10.3, ROOM.h - WY1);
  [[-5.3, -4.1], [-1.9, -1.1], [1.1, 1.9], [4.1, 5.0]].forEach(([a, b]) => wallBox(-7.3, -7.0, WY0, WY1, a, b, b - a, WY1 - WY0));
  // baseboard on the back wall
  block(scene, std(0x2b2724), [0, 0.06, -4.985], [13.9, 0.12, 0.03]);

  // steel factory windows, sills and old radiators
  const steel = std(0x15181b, { roughness: 0.5, metalness: 0.5 });
  const glass = new THREE.MeshStandardMaterial({ color: C(0xbfd8ea), transparent: true, opacity: 0.1, roughness: 0.05, metalness: 0.1, depthWrite: false });
  const sillMat = std(0x8a6a4a, { roughness: 0.6 }), radMat = metal(0xc9c4ba, 0.5);
  WIN.forEach(([z0, z1]) => {
    const zc = (z0 + z1) / 2, wz = z1 - z0, h = WY1 - WY0, xw = -7.15;
    for (let i = 0; i <= 4; i++) block(scene, steel, [xw, WY0 + (h * i) / 4, zc], [0.05, 0.04, wz]);
    for (let i = 0; i <= 4; i++) { const m = block(scene, steel, [xw, WY0 + h / 2, z0 + (wz * i) / 4], [0.05, h, 0.04]); m.castShadow = true; }
    const g = mesh(new THREE.PlaneGeometry(wz, h), glass, scene, false); g.position.set(xw, WY0 + h / 2, zc); g.rotation.y = Math.PI / 2; g.receiveShadow = false;
    block(scene, sillMat, [-6.93, WY0 - 0.02, zc], [0.18, 0.05, wz + 0.1]);
    const rad = new THREE.Group(); rad.position.set(-6.86, 0, zc); scene.add(rad);
    for (let i = 0; i < 14; i++) block(rad, radMat, [0, 0.42, -0.42 + i * 0.065], [0.14, 0.62, 0.045]);
    block(rad, radMat, [0, 0.12, 0], [0.12, 0.05, 0.92]); block(rad, radMat, [0, 0.73, 0], [0.12, 0.04, 0.92]);
  });

  // the city outside: a painted backdrop past the windows
  const sky = makeCanvas(2048, 680), skyTex = tex(sky);
  function drawSkyline() {
    const P = PARTS[part], x = sky.getContext('2d'), W = sky.width, H = sky.height, r = rnd(99);
    const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, P.sky[0]); g.addColorStop(0.75, P.sky[1]); g.addColorStop(1, P.haze);
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    if (part === 'night') for (let i = 0; i < 90; i++) { x.fillStyle = 'rgba(255,255,255,' + (0.2 + r() * 0.5) + ')'; x.fillRect(r() * W, r() * H * 0.45, 2, 2); }
    if (part !== 'night') { x.fillStyle = part === 'day' ? 'rgba(255,255,255,0.55)' : 'rgba(255,200,160,0.35)'; for (let i = 0; i < 6; i++) { const cx = r() * W, cy = 60 + r() * 160; for (let k = 0; k < 6; k++) { x.beginPath(); x.ellipse(cx + k * 34, cy + Math.sin(k) * 8, 60, 18, 0, 0, Math.PI * 2); x.fill(); } } }
    const layers = [[0.50, 0.74, 30, 120], [0.40, 0.58, 22, 90], [0.28, 0.45, 14, 70]];
    layers.forEach(([lo, hi, minW, maxW], li) => {
      let px = -20;
      while (px < W) {
        const bw = minW * 3 + r() * maxW * 1.6, bh = H * (lo + r() * (hi - lo));
        const by = H - bh;
        x.fillStyle = P.bldg[li]; x.fillRect(px, by, bw, bh);
        if (li === 0 && r() < 0.18) { x.fillRect(px + bw / 2 - 6, by - 60, 12, 60); x.fillRect(px + bw / 2 - 2, by - 110, 4, 50); }  // a spire
        // windows
        const lit = P.lit * (li === 2 ? 1 : 0.8);
        for (let wy = by + 10; wy < H - 10; wy += 16) for (let wx = px + 6; wx < px + bw - 8; wx += 12) {
          if (r() < lit) { x.fillStyle = r() < 0.7 ? 'rgba(255,214,140,0.9)' : 'rgba(200,225,255,0.8)'; x.fillRect(wx, wy, 6, 8); }
          else if (part === 'day' && r() < 0.5) { x.fillStyle = 'rgba(255,255,255,0.10)'; x.fillRect(wx, wy, 6, 8); }
        }
        // water towers on the nearest roofs
        if (li === 2 && r() < 0.55) {
          const tx = px + 20 + r() * (bw - 70), ty = by;
          x.fillStyle = part === 'night' ? '#0a0e17' : part === 'evening' ? '#1d1a24' : '#4a3a2e';
          for (let k = 0; k < 4; k++) x.fillRect(tx + 4 + k * 14, ty - 34, 3, 34);
          x.fillRect(tx, ty - 76, 50, 44); x.beginPath(); x.moveTo(tx - 4, ty - 76); x.lineTo(tx + 25, ty - 100); x.lineTo(tx + 54, ty - 76); x.fill();
          x.fillStyle = 'rgba(0,0,0,0.25)'; for (let k = 0; k < 5; k++) x.fillRect(tx, ty - 70 + k * 9, 50, 1.5);
        }
        px += bw + 4 + r() * 18;
      }
    });
    skyTex.needsUpdate = true;
  }
  drawSkyline();
  const backdrop = mesh(new THREE.PlaneGeometry(10.3, 4.3), new THREE.MeshBasicMaterial({ map: skyTex, fog: false, toneMapped: false }), scene, false);
  backdrop.position.set(-8.4, 1.95, -0.15); backdrop.rotation.y = Math.PI / 2;

  // cast iron columns
  const colMat = std(0xe8e2d6, { roughness: 0.5 });
  const COLUMNS = [[-4.45, -3.5], [-4.45, 2.8], [3.05, -3.5], [3.05, 2.8]];
  COLUMNS.forEach(([cx, cz]) => {
    cyl(scene, colMat, [cx, ROOM.h / 2, cz], 0.13, ROOM.h);
    cyl(scene, colMat, [cx, 0.1, cz], 0.2, 0.2); cyl(scene, colMat, [cx, 0.24, cz], 0.16, 0.08);
    cyl(scene, colMat, [cx, ROOM.h - 0.2, cz], 0.13, 0.25, 0.26);
  });

  // exposed ductwork, a sprinkler pipe and Edison pendants
  const ductMat = metal(0xb9bec4, 0.42);
  const duct = new THREE.Group(); scene.add(duct);
  rod(duct, ductMat, [-6.95, 4.28, -3.4], [6.95, 4.28, -3.4], 0.22);
  for (let x = -6.4; x < 7; x += 1.2) { rod(duct, metal(0x9aa0a6, 0.4), [x, 4.28, -3.4], [x + 0.05, 4.28, -3.4], 0.235); rod(duct, steel, [x + 0.3, 4.5, -3.4], [x + 0.3, ROOM.h, -3.4], 0.012); }
  for (let x = -5.2; x < 7; x += 2.4) { const v = block(duct, std(0x2a2d31), [x, 4.05, -3.4], [0.36, 0.06, 0.2]); v.castShadow = false; }
  const bulbs = [];
  const bulbMat = new THREE.MeshStandardMaterial({ color: C(0xffd59a), emissive: C(0xffb35c), emissiveIntensity: 1.5, roughness: 0.3 });
  const globeMat = new THREE.MeshStandardMaterial({ color: C(0xffffff), transparent: true, opacity: 0.22, roughness: 0.05, depthWrite: false });
  function pendant(x, z, low) {
    const y = low || 2.55;
    rod(scene, std(0x111111), [x, ROOM.h, z], [x, y + 0.13, z], 0.006);
    cyl(scene, std(0x1a1a1a, { metalness: 0.6, roughness: 0.4 }), [x, y + 0.14, z], 0.035, 0.05);
    const b = ball(scene, bulbMat, [x, y, z], 0.045, [1, 1.45, 1]); b.castShadow = false;
    const g = ball(scene, globeMat, [x, y, z], 0.12); g.castShadow = false;
    bulbs.push(b);
  }
  [-3.0, -1.4, 0.2, 1.8].forEach((x) => { pendant(x, -2.4); pendant(x, 0.6); });
  pendant(-6.1, -0.6, 2.35); pendant(4.4, -3.9, 2.4); pendant(5.6, -3.9, 2.4);
  lampLight(-0.6, 2.4, -2.4, 8); lampLight(-0.6, 2.4, 0.6, 8); lampLight(5.0, 2.3, -3.6, 6); lampLight(-6.0, 2.2, -0.6, 5);

  // neon sign, a bike on the wall and a wall clock
  const neonC = makeCanvas(1024, 256), neonTex = tex(neonC);
  function drawNeon() {
    const x = neonC.getContext('2d'), col = ROSTER.neon || '#ff5fa2';
    x.clearRect(0, 0, 1024, 256);
    x.font = 'italic 600 150px "Source Sans 3", "Source Sans Pro", system-ui, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    // A long name (?name=, office/roster.js) is drawn narrower so it still fits on the sign.
    const sign = ROSTER.company || 'Building58', fit = Math.min(1, 940 / x.measureText(sign).width);
    x.setTransform(fit, 0, 0, 1, 512 * (1 - fit), 0);
    for (const [blur, alpha] of [[44, 0.55], [22, 0.75], [8, 1]]) { x.shadowColor = col; x.shadowBlur = blur; x.fillStyle = col; x.globalAlpha = alpha; x.fillText(sign, 512, 130); }
    x.shadowBlur = 0; x.globalAlpha = 1; x.fillStyle = '#fff4fa'; x.lineWidth = 3; x.strokeStyle = '#fff'; x.fillText(sign, 512, 130);
    x.setTransform(1, 0, 0, 1, 0, 0);
    neonTex.needsUpdate = true;
  }
  const neon = mesh(new THREE.PlaneGeometry(2.8, 0.7), new THREE.MeshBasicMaterial({ map: neonTex, transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending }), scene, false);
  neon.position.set(-0.95, 3.2, -4.97);
  const neonLight = new THREE.PointLight(C(ROSTER.neon || '#ff5fa2'), 0.6, 4, 2); neonLight.position.set(-0.95, 3.1, -4.4); scene.add(neonLight);
  drawNeon();

  const bike = new THREE.Group(); bike.position.set(-5.4, 1.55, -4.86); scene.add(bike);
  const tire = std(0x151515, { roughness: 0.8 }), frameM = std(0x2f8f8a, { roughness: 0.35, metalness: 0.3 });
  [-0.52, 0.52].forEach((x) => { const t = mesh(new THREE.TorusGeometry(0.33, 0.022, 10, 40), tire, bike); t.position.set(x, 0, 0); ball(bike, metal(0xcccccc), [x, 0, 0], 0.03); });
  rod(bike, frameM, [-0.52, 0, 0], [-0.08, 0, 0], 0.018); rod(bike, frameM, [-0.52, 0, 0], [-0.18, 0.36, 0], 0.016);
  rod(bike, frameM, [-0.08, 0, 0], [-0.18, 0.36, 0], 0.02); rod(bike, frameM, [-0.18, 0.36, 0], [0.38, 0.36, 0], 0.018);
  rod(bike, frameM, [-0.08, 0, 0], [0.4, 0.3, 0], 0.02); rod(bike, frameM, [0.52, 0, 0], [0.4, 0.42, 0], 0.016);
  block(bike, std(0x2a1f1a), [-0.2, 0.43, 0], [0.2, 0.035, 0.07]); rod(bike, metal(0xbbbbbb), [0.38, 0.5, -0.18], [0.38, 0.5, 0.18], 0.012);
  block(scene, metal(0x333333), [-5.4, 1.7, -4.95], [0.5, 0.05, 0.06]);

  const clockC = makeCanvas(256, 256), clockTex = tex(clockC);
  let clockMin = -1;
  function drawClock() {
    const d = new Date(), m = d.getHours() * 60 + d.getMinutes();
    if (m === clockMin) return; clockMin = m;
    const x = clockC.getContext('2d'); x.clearRect(0, 0, 256, 256);
    x.fillStyle = '#f4efe4'; x.beginPath(); x.arc(128, 128, 122, 0, Math.PI * 2); x.fill();
    x.strokeStyle = '#1c1c1c'; x.lineWidth = 10; x.stroke();
    x.fillStyle = '#1c1c1c'; x.font = '600 26px "Roboto Mono", monospace'; x.textAlign = 'center'; x.textBaseline = 'middle';
    for (let i = 1; i <= 12; i++) { const a = (i / 12) * Math.PI * 2; x.fillText(String(i), 128 + Math.sin(a) * 92, 128 - Math.cos(a) * 92); }
    const hand = (a, len, w) => { x.lineWidth = w; x.lineCap = 'round'; x.beginPath(); x.moveTo(128, 128); x.lineTo(128 + Math.sin(a) * len, 128 - Math.cos(a) * len); x.stroke(); };
    hand(((m % 720) / 720) * Math.PI * 2, 56, 9); hand(((m % 60) / 60) * Math.PI * 2, 84, 6);
    x.fillStyle = '#b83a2e'; x.beginPath(); x.arc(128, 128, 8, 0, Math.PI * 2); x.fill();
    clockTex.needsUpdate = true;
  }
  const clockFace = mesh(new THREE.CircleGeometry(0.42, 48), new THREE.MeshStandardMaterial({ map: clockTex, roughness: 0.5 }), scene, false);
  clockFace.position.set(2.05, 2.75, -4.94);
  const rim = mesh(new THREE.TorusGeometry(0.43, 0.03, 10, 48), metal(0x222222), scene); rim.position.copy(clockFace.position);
  drawClock();

  // the kanban board: what each person is doing, what waits on you, and what got done
  const boardC = makeCanvas(1024, 512), boardTex = tex(boardC);
  const board = new THREE.Group(); board.position.set(-0.95, 1.7, -4.95); scene.add(board);
  block(board, metal(0xd5d8dc, 0.35), [0, 0, 0], [3.3, 1.7, 0.04]);
  const boardFace = mesh(new THREE.PlaneGeometry(3.2, 1.6), new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.35 }), board, false); boardFace.position.z = 0.025;
  block(board, metal(0xb0b4b8), [0, -0.86, 0.06], [3.2, 0.03, 0.08]);
  [0x2e74d1, 0xd13a2e, 0x2e9f5a].forEach((c, i) => cyl(board, std(c), [-0.3 + i * 0.12, -0.83, 0.07], 0.012, 0.13));

  // ---------- furniture ----------
  const wood = std(0xb08a5f, { roughness: 0.55 }), darkWood = std(0x5c4030, { roughness: 0.6 }), blackMetal = std(0x1c1c1e, { roughness: 0.45, metalness: 0.4 });
  const OBST = { rects: [], circles: [] };
  const solid = (x0, x1, z0, z1) => OBST.rects.push([x0, x1, z0, z1]);
  const solidC = (x, z, r) => OBST.circles.push([x, z, r]);
  solid(-7.3, -6.7, -5.3, 5); solid(-7.3, 7, -5.3, -4.95);
  COLUMNS.forEach(([x, z]) => solidC(x, z, 0.2));

  function bench(cx, cz, len) {
    const g = new THREE.Group(); g.position.set(cx, 0, cz); scene.add(g);
    block(g, wood, [0, 0.725, 0], [len, 0.045, 0.82]);
    for (const sx of [-len / 2 + 0.08, -0.03, len / 2 - 0.08]) for (const sz of [-0.36, 0.36]) block(g, blackMetal, [sx, 0.36, sz], [0.04, 0.72, 0.04]);
    for (const sx of [-len / 2 + 0.08, -0.03, len / 2 - 0.08]) block(g, blackMetal, [sx, 0.05, 0], [0.04, 0.04, 0.76]);
    solid(cx - len / 2, cx + len / 2, cz - 0.41, cz + 0.41);
    return g;
  }
  bench(-0.6, -2.4, 6.4); bench(-0.6, 0.6, 6.4);
  const leadDesk = new THREE.Group(); leadDesk.position.set(-6.1, 0, -0.6); scene.add(leadDesk);
  block(leadDesk, darkWood, [0, 0.725, 0], [0.82, 0.05, 1.7]);
  for (const sx of [-0.36, 0.36]) for (const sz of [-0.8, 0.8]) block(leadDesk, blackMetal, [sx, 0.36, sz], [0.04, 0.72, 0.04]);
  solid(-6.51, -5.69, -1.45, 0.25);

  function chair(x, z, yaw, color) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = yaw; scene.add(g);
    const seat = std(color || 0x2a2d33, { roughness: 0.8 });
    for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; block(g, blackMetal, [Math.sin(a) * 0.15, 0.06, -0.05 + Math.cos(a) * 0.15], [0.04, 0.03, 0.3], [0, a, 0]); }
    cyl(g, metal(0x888888), [0, 0.24, -0.05], 0.025, 0.36);
    const top = new THREE.Group(); top.position.set(0, 0, -0.05); g.add(top);  // what swivels, about the column
    block(top, seat, [0, 0.44, 0.01], [0.46, 0.07, 0.44]);
    block(top, seat, [0, 0.78, -0.25], [0.42, 0.46, 0.06], [-0.12, 0, 0]);
    rod(top, blackMetal, [0, 0.46, -0.19], [0, 0.6, -0.25], 0.018);
    return top;
  }
  function monitor(parent, p, yaw) {
    const g = new THREE.Group(); g.position.set(p[0], p[1], p[2]); g.rotation.y = yaw; parent.add(g);
    block(g, blackMetal, [0, 0.01, 0], [0.22, 0.02, 0.16]); rod(g, blackMetal, [0, 0, -0.03], [0, 0.32, -0.03], 0.018);
    block(g, std(0x101114, { roughness: 0.4 }), [0, 0.38, -0.01], [0.66, 0.4, 0.03]);
    const c = makeCanvas(512, 304), t = tex(c);
    const face = mesh(new THREE.PlaneGeometry(0.62, 0.368), new THREE.MeshBasicMaterial({ map: t, toneMapped: false }), g, false);
    face.position.set(0, 0.38, 0.0065);
    return { canvas: c, ctx: c.getContext('2d'), tex: t, group: g };
  }
  function mugMesh(color) {
    const g = new THREE.Group(), m = std(color || '#ffffff', { roughness: 0.35 });
    const body = mesh(new THREE.CylinderGeometry(0.04, 0.036, 0.09, 18), m, g); body.position.y = 0.045;
    const h = mesh(new THREE.TorusGeometry(0.024, 0.007, 8, 16), m, g); h.position.set(0.045, 0.048, 0); h.rotation.y = 0;
    const coffee = mesh(new THREE.CircleGeometry(0.034, 16), std(0x3b2414, { roughness: 0.2 }), g, false); coffee.rotation.x = -Math.PI / 2; coffee.position.y = 0.084;
    return g;
  }
  function plant(x, z, s, potColor) {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.scale.setScalar(s || 1); scene.add(g);
    cyl(g, std(potColor || 0xe9e4da, { roughness: 0.6 }), [0, 0.2, 0], 0.17, 0.4, 0.21);
    cyl(g, std(0x3b2a1e), [0, 0.39, 0], 0.19, 0.02);
    const leaf = std(0x3f7a3a, { roughness: 0.65 }), leaf2 = std(0x5a9a48, { roughness: 0.65 }), r = rnd(Math.floor(x * 100 + z * 7));
    for (let i = 0; i < 13; i++) {
      const a = r() * Math.PI * 2, h = 0.55 + r() * 0.75, d = 0.08 + r() * 0.22;
      const tip = [Math.sin(a) * d * 1.6, h, Math.cos(a) * d * 1.6];
      rod(g, std(0x4c6b34), [0, 0.38, 0], tip, 0.008);
      const l = ball(g, r() < 0.5 ? leaf : leaf2, tip, 0.11 + r() * 0.06, [1, 0.22, 1.6]); l.rotation.set(r() - 0.5, a, (r() - 0.5) * 0.8);
    }
    solidC(x, z, 0.3 * (s || 1));
    return g;
  }
  function smallPlant(parent, p) {
    const g = new THREE.Group(); g.position.set(p[0], p[1], p[2]); parent.add(g);
    cyl(g, std(0xd9cbb5), [0, 0.05, 0], 0.045, 0.1, 0.05);
    for (let i = 0; i < 6; i++) { const l = block(g, std(0x4f8a3c), [Math.sin(i) * 0.015, 0.16, Math.cos(i) * 0.015], [0.018, 0.2, 0.006]); l.rotation.set(Math.sin(i * 2) * 0.25, i, Math.cos(i * 3) * 0.25); }
  }

  // ---------- desks and seats ----------
  // Each desk: where the person sits (pelvis), facing yaw, the monitor and the desk mug.
  const DESKS = {};
  function desk(key, x, z, yaw, opts) {
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const at = (f, s, y) => [x + fwd.x * f + side.x * s, y, z + fwd.z * f + side.z * s];
    const g = new THREE.Group(); scene.add(g);
    const screens = [];
    if (opts && opts.dual) { screens.push(monitor(g, at(0.82, 0.36, 0.75), yaw + Math.PI + 0.2)); screens.push(monitor(g, at(0.82, -0.36, 0.75), yaw + Math.PI - 0.2)); }
    else screens.push(monitor(g, at(0.84, 0, 0.75), yaw + Math.PI));
    const kb = block(g, std(0x2b2e33, { roughness: 0.5 }), at(0.5, 0, 0.758), [0.4, 0.018, 0.13]); kb.rotation.y = yaw;
    const mouse = ball(g, std(0x2b2e33, { roughness: 0.4 }), at(0.5, -0.31, 0.762), 0.03, [0.7, 0.35, 1]); mouse.rotation.y = yaw;
    const mug = mugMesh((opts && opts.mug) || '#ffffff'); mug.position.set(...at(0.62, 0.38, 0.75)); g.add(mug); mug.visible = false;
    if (opts && opts.plant) smallPlant(g, at(0.95, opts.plant, 0.75));
    if (opts && opts.lamp) { const lp = at(0.9, -0.55, 0.75); cyl(g, blackMetal, lp, 0.06, 0.02); rod(g, blackMetal, lp, [lp[0], lp[1] + 0.38, lp[2]], 0.01); const sh = cyl(g, std(0x1d3f72), [lp[0], lp[1] + 0.4, lp[2]], 0.09, 0.1, 0.04); sh.rotation.x = 0.3; }
    const seat = chair(...at(-0.02, 0, 0).filter((_, i) => i !== 1), yaw, opts && opts.chair);
    DESKS[key] = { key, x, z, yaw, screens, mug, chair: seat };
    SPOTS[key] = { key, pos: new THREE.Vector3(x, 0, z), yaw, sit: 'chair', approach: new THREE.Vector3(x + fwd.x * 0.14, 0, z + fwd.z * 0.14) };
  }
  const SPOTS = {};
  function spot(key, x, z, yaw, extra) { SPOTS[key] = Object.assign({ key, pos: new THREE.Vector3(x, 0, z), yaw, sit: null }, extra || {}); }

  desk('lead', -5.42, -0.6, -Math.PI / 2, { dual: true, mug: (ROSTER.lead.look || {}).mug, plant: 0.0, lamp: true, chair: 0x3a2a24 });
  const seatX = [-3.0, -1.4, 0.2, 1.8];
  seatX.forEach((x, i) => desk('a' + i, x, -1.7, Math.PI, { plant: i % 2 ? 0.45 : null, lamp: i === 2 }));
  seatX.forEach((x, i) => desk('b' + i, x, 1.3, Math.PI, { plant: i % 2 ? null : -0.5 }));

  // coffee bar with an espresso machine, open shelves and a fridge
  const counter = new THREE.Group(); scene.add(counter);
  block(counter, std(0x253447, { roughness: 0.55 }), [4.8, 0.44, -4.64], [2.8, 0.88, 0.62]);
  for (let i = 0; i < 4; i++) { block(counter, std(0x2c3e55, { roughness: 0.5 }), [3.75 + i * 0.7, 0.46, -4.325], [0.64, 0.74, 0.02]); block(counter, metal(0xc9b37a, 0.3), [3.75 + i * 0.7 + 0.22, 0.7, -4.31], [0.02, 0.14, 0.02]); }
  block(counter, std(0xc69a6a, { roughness: 0.45 }), [4.8, 0.905, -4.63], [2.86, 0.05, 0.68]);
  solid(3.38, 6.22, -4.97, -4.29);
  const espresso = new THREE.Group(); espresso.position.set(4.35, 0.93, -4.68); counter.add(espresso);
  const chrome = metal(0xd8dade, 0.22), espBody = std(0xb8392e, { roughness: 0.35, metalness: 0.2 });
  block(espresso, espBody, [0, 0.21, 0], [0.5, 0.42, 0.38]); block(espresso, chrome, [0, 0.44, 0], [0.52, 0.04, 0.4]);
  block(espresso, chrome, [0, 0.03, 0.12], [0.46, 0.04, 0.2]);
  cyl(espresso, chrome, [0, 0.27, 0.23], 0.05, 0.08); rod(espresso, std(0x1a1a1a), [0, 0.22, 0.25], [0.02, 0.22, 0.45], 0.016);
  rod(espresso, chrome, [0.2, 0.3, 0.2], [0.24, 0.12, 0.27], 0.008);
  const espLight = ball(espresso, new THREE.MeshStandardMaterial({ color: C(0x331111), emissive: C(0xff3b2e), emissiveIntensity: 0 }), [-0.18, 0.36, 0.19], 0.018);
  for (let i = 0; i < 4; i++) { const cup = cyl(espresso, std(0xffffff, { roughness: 0.3 }), [-0.15 + i * 0.1, 0.49, 0], 0.03, 0.05, 0.035); cup.castShadow = false; }
  const grinder = new THREE.Group(); grinder.position.set(3.85, 0.93, -4.7); counter.add(grinder);
  block(grinder, std(0x2b2b2b), [0, 0.16, 0], [0.18, 0.32, 0.22]); cyl(grinder, std(0x6b4a2f, { transparent: true, opacity: 0.8 }), [0, 0.42, 0], 0.08, 0.2, 0.05);
  const brewMug = mugMesh('#ffffff'); brewMug.position.set(4.35, 0.98, -4.55); counter.add(brewMug); brewMug.visible = false;
  for (let s = 0; s < 2; s++) {
    const y = 1.55 + s * 0.45;
    block(counter, darkWood, [4.8, y, -4.84], [2.4, 0.04, 0.26]);
    for (const bx of [3.75, 5.85]) block(counter, blackMetal, [bx, y - 0.06, -4.9], [0.03, 0.12, 0.18]);
    for (let i = 0; i < 9; i++) {
      const it = (i * 7 + s * 3) % 5;
      if (it < 3) { const m = mugMesh(['#e8e4dc', '#3a7ca5', '#d9822b', '#2f6b4f', '#f0c25e'][(i + s) % 5]); m.position.set(3.85 + i * 0.25, y + 0.02, -4.82); m.rotation.y = 0.4 * i; counter.add(m); }
      else cyl(counter, std(it === 3 ? 0xd9c8a0 : 0x6b4a2f, { roughness: 0.4 }), [3.85 + i * 0.25, y + 0.11, -4.82], 0.05, 0.18);
    }
  }
  const fridge = new THREE.Group(); fridge.position.set(6.62, 0, -4.64); scene.add(fridge);
  block(fridge, std(0xa7d3c4, { roughness: 0.35 }), [0, 0.9, 0], [0.62, 1.8, 0.62]);
  const fridgeDoor = new THREE.Group(); fridgeDoor.position.set(-0.31, 0, 0.31); fridge.add(fridgeDoor);
  block(fridgeDoor, std(0xb4dccd, { roughness: 0.3 }), [0.31, 0.9, 0.02], [0.62, 1.76, 0.04]);
  block(fridgeDoor, metal(0xdddddd, 0.25), [0.56, 1.1, 0.06], [0.03, 0.4, 0.03]);
  solid(6.3, 6.95, -4.97, -4.3);
  const steam = [];
  const steamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
  for (let i = 0; i < 8; i++) { const p = mesh(G.sph, steamMat.clone(), scene, false); p.castShadow = false; p.scale.setScalar(0.04); p.visible = false; steam.push({ m: p, t: i / 8 }); }

  // a high table for chats
  const bar = new THREE.Group(); bar.position.set(5.0, 0, -2.25); scene.add(bar);
  cyl(bar, darkWood, [0, 1.05, 0], 0.36, 0.04); cyl(bar, blackMetal, [0, 0.53, 0], 0.03, 1.02); cyl(bar, blackMetal, [0, 0.02, 0], 0.26, 0.03);
  solidC(5.0, -2.25, 0.4);

  // the lounge: rug, couch, coffee table, armchair, arc lamp
  const rugC = makeCanvas(512, 512); (function () {
    const x = rugC.getContext('2d'); x.fillStyle = '#8c3b2f'; x.fillRect(0, 0, 512, 512);
    x.strokeStyle = '#e6d3b1'; x.lineWidth = 10; x.strokeRect(24, 24, 464, 464); x.strokeStyle = '#1f3b4d'; x.lineWidth = 16; x.strokeRect(52, 52, 408, 408);
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) { const cx = 112 + i * 72, cy = 112 + j * 72; x.fillStyle = (i + j) % 2 ? '#e6d3b1' : '#d08a3a'; x.beginPath(); x.moveTo(cx, cy - 26); x.lineTo(cx + 26, cy); x.lineTo(cx, cy + 26); x.lineTo(cx - 26, cy); x.closePath(); x.fill(); }
  })();
  const rug = mesh(new THREE.PlaneGeometry(3.0, 3.6), new THREE.MeshStandardMaterial({ map: tex(rugC), roughness: 0.95 }), scene, false);
  rug.rotation.x = -Math.PI / 2; rug.position.set(5.25, 0.006, 2.35);
  const velvet = std(0x2f5d4a, { roughness: 0.85 });
  const couch = new THREE.Group(); couch.position.set(5.25, 0, 0.85); scene.add(couch);
  block(couch, velvet, [0, 0.23, 0], [2.2, 0.3, 0.9]); block(couch, velvet, [0, 0.62, -0.33], [2.2, 0.55, 0.24]);
  block(couch, velvet, [-1.05, 0.5, 0], [0.18, 0.36, 0.9]); block(couch, velvet, [1.05, 0.5, 0], [0.18, 0.36, 0.9]);
  for (let i = -1; i <= 1; i++) { block(couch, std(0x346a54, { roughness: 0.85 }), [i * 0.65, 0.42, 0.06], [0.62, 0.1, 0.72]); }
  ball(couch, std(0xd9822b, { roughness: 0.9 }), [-0.8, 0.6, -0.12], 0.13, [1, 0.9, 0.45]).rotation.z = 0.3;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) cyl(couch, darkWood, [sx * 1.0, 0.04, sz * 0.38], 0.03, 0.08);
  solid(4.12, 6.38, 0.38, 1.32);
  const ctable = new THREE.Group(); ctable.position.set(5.25, 0, 2.2); scene.add(ctable);
  block(ctable, wood, [0, 0.4, 0], [1.1, 0.05, 0.55]); for (const sx of [-0.5, 0.5]) for (const sz of [-0.22, 0.22]) block(ctable, blackMetal, [sx, 0.19, sz], [0.03, 0.38, 0.03]);
  block(ctable, std(0x1f3b4d), [-0.2, 0.44, 0], [0.24, 0.03, 0.3]); block(ctable, std(0xd9c8a0), [-0.19, 0.465, 0.01], [0.22, 0.02, 0.28]);
  const cmug = mugMesh('#3a7ca5'); cmug.position.set(0.25, 0.425, 0.08); ctable.add(cmug);
  solid(4.7, 5.8, 1.92, 2.48);
  const leather = std(0x7a4a2c, { roughness: 0.55 });
  const arm = new THREE.Group(); arm.position.set(3.85, 0, 3.2); arm.rotation.y = Math.PI / 2; scene.add(arm);
  block(arm, leather, [0, 0.24, 0], [0.82, 0.3, 0.8]); block(arm, leather, [0, 0.62, -0.32], [0.82, 0.5, 0.18]);
  block(arm, leather, [-0.36, 0.48, 0.02], [0.12, 0.3, 0.78]); block(arm, leather, [0.36, 0.48, 0.02], [0.12, 0.3, 0.78]);
  solid(3.44, 4.26, 2.8, 3.6);
  // The arc lamp stands at the couch's right end, and its shade hangs over the arm, high, so it lights
  // the couch without hiding the head of someone sitting there.
  const LAMP = { x: 6.72, z: 0.5 }, REACH = { x: -0.3, z: 0.44 };
  const lampG = new THREE.Group(); lampG.position.set(LAMP.x, 0, LAMP.z); scene.add(lampG);
  block(lampG, std(0xe8e4dc, { roughness: 0.3 }), [0, 0.05, 0], [0.28, 0.1, 0.28]);
  const arcPts = []; for (let i = 0; i <= 14; i++) { const a = (i / 14) * Math.PI * 0.62; arcPts.push([Math.sin(a) * REACH.x, 0.1 + Math.sin(a + 0.35) * 1.62 + i * 0.03, Math.sin(a) * REACH.z]); }
  for (let i = 0; i < arcPts.length - 1; i++) rod(lampG, metal(0xbfbfbf, 0.25), arcPts[i], arcPts[i + 1], 0.012);
  const shade = arcPts[14];
  cyl(lampG, metal(0xbfbfbf, 0.25), [shade[0], shade[1] - 0.1, shade[2]], 0.22, 0.16, 0.06);
  lampLight(LAMP.x + shade[0], shade[1] - 0.25, LAMP.z + shade[2], 5);
  solidC(LAMP.x, LAMP.z, 0.25);

  // a ping pong table
  const ppC = makeCanvas(548, 305); (function () { const x = ppC.getContext('2d'); x.fillStyle = '#1f4f7a'; x.fillRect(0, 0, 548, 305); x.strokeStyle = '#f2f2f2'; x.lineWidth = 6; x.strokeRect(3, 3, 542, 299); x.lineWidth = 2; x.beginPath(); x.moveTo(0, 152.5); x.lineTo(548, 152.5); x.stroke(); })();
  const pp = new THREE.Group(); pp.position.set(-0.6, 0, 3.4); scene.add(pp);
  block(pp, std(0x1f4f7a, { roughness: 0.4 }), [0, 0.74, 0], [2.74, 0.03, 1.525]);
  const ppTop = mesh(new THREE.PlaneGeometry(2.74, 1.525), new THREE.MeshStandardMaterial({ map: tex(ppC), roughness: 0.4 }), pp, false); ppTop.rotation.x = -Math.PI / 2; ppTop.position.y = 0.757;
  block(pp, std(0xf2f2f2, { transparent: true, opacity: 0.85 }), [0, 0.835, 0], [0.01, 0.15, 1.6]);
  for (const sx of [-1.1, 1.1]) for (const sz of [-0.6, 0.6]) block(pp, blackMetal, [sx, 0.37, sz], [0.05, 0.72, 0.05]);
  solid(-1.97, 0.77, 2.64, 4.16);
  const ppBall = ball(scene, std(0xffffff, { roughness: 0.3 }), [-0.6, 0.8, 3.4], 0.025); ppBall.visible = false;
  function paddleMesh(color) {
    const g = new THREE.Group(); const head = mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.012, 20), std(color, { roughness: 0.6 }), g); head.position.y = -0.09; head.rotation.z = Math.PI / 2;
    block(g, std(0xc69a6a), [0, -0.02, 0], [0.022, 0.1, 0.03]); return g;
  }
  const tablePaddles = [paddleMesh(0xc0392b), paddleMesh(0x222222)];
  tablePaddles.forEach((p, i) => { p.position.set(-0.6 + (i ? 0.9 : -0.9), 0.77, 3.2 + i * 0.3); p.rotation.set(0, 0.6 + i, Math.PI / 2); scene.add(p); });

  // plants and the window seats
  plant(-6.45, -4.45, 1.25, 0xe9e4da); plant(-6.45, 4.45, 1.1, 0xb8735a); plant(6.6, 4.55, 1.2, 0x2b2b2b); plant(2.75, -4.55, 0.95, 0xb8735a); plant(-3.8, 4.5, 0.9);

  // ---------- spots people go to ----------
  spot('espresso', 4.3, -3.85, Math.PI, { label: 'Making coffee' });
  spot('fridge', 6.45, -3.75, Math.PI, { label: 'At the fridge' });
  spot('shelf', 5.3, -3.85, Math.PI, { label: 'Getting a snack' });
  spot('bar-w', 4.42, -2.25, Math.PI / 2, { group: 'bar' }); spot('bar-e', 5.58, -2.25, -Math.PI / 2, { group: 'bar' }); spot('bar-s', 5.0, -1.65, Math.PI, { group: 'bar' });
  // seat: the height of the cushion's top, which the pose sits on (seatOn in office/poses.js)
  [4.6, 5.25, 5.9].forEach((x, i) => spot('couch-' + i, x, 0.98, 0, { sit: 'couch', seat: 0.47, approach: new THREE.Vector3(x, 0, 1.62) }));
  spot('armchair', 3.92, 3.2, Math.PI / 2, { sit: 'couch', seat: 0.39, approach: new THREE.Vector3(4.55, 0, 3.2) });
  spot('win-0', -6.3, -3.0, -Math.PI / 2, { label: 'At the window' }); spot('win-1', -6.3, 2.4, -Math.PI / 2, { label: 'At the window' }); spot('win-2', -6.3, 3.5, -Math.PI / 2, { label: 'At the window' });
  spot('board-0', -1.35, -3.75, Math.PI, { label: 'At the board' }); spot('board-1', -0.35, -3.75, Math.PI, { label: 'At the board' });
  spot('pp-w', -2.42, 3.4, Math.PI / 2); spot('pp-e', 1.22, 3.4, -Math.PI / 2);
  // where the manager stands: inside the door, behind each person's chair, and places to look around from
  spot('boss-door', 1.7, -4.2, 0); spot('boss-aisle', -0.6, -0.55, 0.5); spot('boss-lounge', 3.2, 0.4, -0.9); spot('boss-board', -0.85, -3.55, Math.PI);
  for (const k in DESKS) { const d = DESKS[k]; spot('boss-behind-' + k, d.x - Math.sin(d.yaw) * 0.78, d.z - Math.cos(d.yaw) * 0.78, d.yaw); }
  for (const k in SPOTS) { const s = SPOTS[k]; if (!s.approach) s.approach = s.pos.clone(); s.by = null; }

  // ---------- walking: a grid over the floor and A* ----------
  const CELL = 0.15, GX = Math.round(14 / CELL), GZ = Math.round(10 / CELL), BODY = 0.24;
  const blocked = new Uint8Array(GX * GZ);
  const cellX = (x) => clamp(Math.floor((x - ROOM.x0) / CELL), 0, GX - 1), cellZ = (z) => clamp(Math.floor((z - ROOM.z0) / CELL), 0, GZ - 1);
  const cx = (i) => ROOM.x0 + (i + 0.5) * CELL, cz = (j) => ROOM.z0 + (j + 0.5) * CELL;
  for (let j = 0; j < GZ; j++) for (let i = 0; i < GX; i++) {
    const x = cx(i), z = cz(j); let b = 0;
    if (x > ROOM.x1 - 0.2 || z > ROOM.z1 - 0.2) b = 1;
    for (const [x0, x1, z0, z1] of OBST.rects) if (x > x0 - BODY && x < x1 + BODY && z > z0 - BODY && z < z1 + BODY) { b = 1; break; }
    if (!b) for (const [ox, oz, r] of OBST.circles) if ((x - ox) ** 2 + (z - oz) ** 2 < (r + BODY) ** 2) { b = 1; break; }
    blocked[j * GX + i] = b;
  }
  function freeCellNear(i, j, grid) {
    if (!grid[j * GX + i]) return [i, j];
    for (let r = 1; r < 12; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const a = i + di, b = j + dj; if (a >= 0 && b >= 0 && a < GX && b < GZ && !grid[b * GX + a]) return [a, b];
    }
    return [i, j];
  }
  function lineFree(ax, az, bx, bz, grid) {
    const d = Math.hypot(bx - ax, bz - az), n = Math.ceil(d / (CELL * 0.5));
    for (let k = 1; k < n; k++) { const t = k / n; if (grid[cellZ(az + (bz - az) * t) * GX + cellX(ax + (bx - ax) * t)]) return false; }
    return true;
  }
  function findPath(from, to, grid = blocked) {
    const [si, sj] = freeCellNear(cellX(from.x), cellZ(from.z), grid), [ti, tj] = freeCellNear(cellX(to.x), cellZ(to.z), grid);
    const S = sj * GX + si, T = tj * GX + ti, N = GX * GZ;
    const gS = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
    const open = [S]; gS[S] = 0;
    const h = (k) => Math.hypot((k % GX) - ti, Math.floor(k / GX) - tj);
    const f = new Float32Array(N).fill(Infinity); f[S] = h(S);
    let guard = 0;
    while (open.length && guard++ < 20000) {
      let bi = 0; for (let k = 1; k < open.length; k++) if (f[open[k]] < f[open[bi]]) bi = k;
      const cur = open[bi]; open[bi] = open[open.length - 1]; open.pop();
      if (cur === T) break;
      if (closed[cur]) continue; closed[cur] = 1;
      const ci = cur % GX, cj = Math.floor(cur / GX);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di, nj = cj + dj; if (ni < 0 || nj < 0 || ni >= GX || nj >= GZ) continue;
        const nk = nj * GX + ni; if (grid[nk] || closed[nk]) continue;
        if (di && dj && (grid[cj * GX + ni] || grid[nj * GX + ci])) continue;
        const g = gS[cur] + (di && dj ? 1.414 : 1);
        if (g < gS[nk]) { gS[nk] = g; came[nk] = cur; f[nk] = g + h(nk); open.push(nk); }
      }
    }
    if (came[T] === -1 && T !== S) return [to.clone()];
    const cells = []; for (let k = T; k !== -1; k = came[k]) { cells.push(k); if (k === S) break; }
    cells.reverse();
    const pts = cells.map((k) => new THREE.Vector3(cx(k % GX), 0, cz(Math.floor(k / GX))));
    pts.push(to.clone());
    const out = []; let a = from.clone();
    for (let k = 0; k < pts.length; k++) {
      const next = pts[k + 1];
      if (next && lineFree(a.x, a.z, next.x, next.z, grid)) continue;
      out.push(pts[k]); a = pts[k];
    }
    return out.length ? out : [to.clone()];
  }

  // ---------- people ----------
  // Poses and the arm routes at a desk are in office/poses.js.
  const { POSE, RIG, typePoseFor, aimArms, seatOn, towards, ARM_CARRY, ARM_CARRY_SIT, ARM_SIP, ARM_PADDLE } = window.OfficePoses;

  function buildPerson(look) {
    const L = Object.assign({ skin: '#d6a27c', hair: '#2a1d17', hairStyle: 'short', shirt: '#556677', pants: '#333a44', shoes: '#222222', height: 1 }, look || {});
    const skin = std(L.skin, { roughness: 0.65 }), shirt = std(L.shirt, { roughness: 0.85 }), pants = std(L.pants, { roughness: 0.85 });
    const shoe = std(L.shoes, { roughness: 0.5 }), hair = std(L.hair, { roughness: 0.9 }), dark = std(0x16110e, { roughness: 0.3 });
    const root = new THREE.Group(); root.scale.setScalar(L.height || 1);
    const pelvis = new THREE.Group(); root.add(pelvis); pelvis.position.y = 0.94;
    ball(pelvis, pants, [0, 0.0, 0], 0.16, [1.02, 0.55, 0.72]);
    const spine = new THREE.Group(); pelvis.add(spine); spine.position.y = RIG.spine;
    const torso = mesh(new THREE.CylinderGeometry(0.165, 0.15, 0.44, 18), shirt, spine); torso.position.y = 0.23; torso.scale.z = 0.66;
    ball(spine, shirt, [0, 0.44, 0], 0.17, [1.12, 0.42, 0.64]);
    ball(spine, shirt, [0, 0.03, 0], 0.15, [1.02, 0.42, 0.68]);
    if (L.top === 'hoodie') {
      ball(spine, shirt, [0, 0.5, -0.07], 0.12, [1.15, 0.6, 0.75]);
      rod(spine, std(0xe8e4dc), [-0.04, 0.42, 0.105], [-0.045, 0.28, 0.11], 0.006); rod(spine, std(0xe8e4dc), [0.04, 0.42, 0.105], [0.045, 0.28, 0.11], 0.006);
      block(spine, shirt, [0, 0.1, 0.1], [0.2, 0.1, 0.03]);
    }
    if (L.top === 'suit') {
      block(spine, std(L.dress || '#e8e4dc', { roughness: 0.7 }), [0, 0.41, 0.098], [0.11, 0.13, 0.02]);
      const tie = std(L.tie || '#8c2f39', { roughness: 0.5 });
      block(spine, tie, [0, 0.45, 0.112], [0.045, 0.035, 0.016]); block(spine, tie, [0, 0.31, 0.11], [0.034, 0.25, 0.012]);
      const lapel = std(L.lapel || L.shirt, { roughness: 0.6 });
      for (const s of [-1, 1]) block(spine, lapel, [0.062 * s, 0.37, 0.108], [0.04, 0.2, 0.014], [0, 0, 0.42 * s]);
      ball(spine, shirt, [0, -0.05, 0], 0.165, [1.02, 0.5, 0.72]);  // the jacket hangs past the waist
    }
    const neck = new THREE.Group(); spine.add(neck); neck.position.y = 0.48;
    cyl(neck, skin, [0, 0.04, 0], 0.045, 0.1);
    const head = new THREE.Group(); neck.add(head); head.position.y = 0.17;
    ball(head, skin, [0, 0, 0.005], 0.105, [0.92, 1.05, 0.98]);
    ball(head, skin, [0, -0.06, 0.03], 0.075, [1, 0.7, 0.95]);
    for (const s of [-1, 1]) { ball(head, dark, [0.036 * s, 0.012, 0.094], 0.012, [1, 1.2, 0.6]); ball(head, skin, [0.1 * s, 0, 0.0], 0.022, [0.6, 1, 1]); }
    ball(head, std(L.skin, { roughness: 0.6 }).clone(), [0, -0.005, 0.105], 0.016, [0.8, 1, 0.9]);
    const hs = L.hairStyle;
    if (hs !== 'bald') {
      if (hs === 'buzz') ball(head, hair, [0, 0.02, -0.005], 0.108, [0.94, 1.0, 1.0]).scale.y *= 0.95;
      else if (hs === 'beanie') { ball(head, std(L.beanie || '#c0392b', { roughness: 0.95 }), [0, 0.045, -0.005], 0.112, [0.96, 0.92, 1.0]); cyl(head, std(L.beanie || '#c0392b', { roughness: 0.95 }), [0, 0.03, -0.005], 0.104, 0.04); ball(head, hair, [0, -0.02, -0.06], 0.09, [1.02, 0.7, 0.8]); }
      else {
        ball(head, hair, [0, 0.03, -0.012], 0.112, [0.97, 0.95, 1.0]);
        if (hs === 'bun') ball(head, hair, [0, 0.1, -0.08], 0.05);
        if (hs === 'long') { ball(head, hair, [0, -0.08, -0.05], 0.11, [1.0, 1.55, 0.62]); ball(head, hair, [0, -0.04, -0.01], 0.112, [1.02, 1.15, 0.9]); }
        if (hs === 'bob') block(head, hair, [0, -0.04, -0.03], [0.22, 0.14, 0.17]);
        if (hs === 'curly') for (let i = 0; i < 14; i++) { const a = i * 2.4; ball(head, hair, [Math.sin(a) * 0.075, 0.07 + Math.cos(i) * 0.03, -0.02 + Math.cos(a) * 0.06], 0.045); }
      }
    }
    if (L.extra === 'glasses') { const gm = std(0x111111, { roughness: 0.3 }); for (const s of [-1, 1]) { const r = mesh(new THREE.TorusGeometry(0.026, 0.004, 6, 18), gm, head); r.position.set(0.038 * s, 0.012, 0.102); } block(head, gm, [0, 0.014, 0.106], [0.024, 0.005, 0.005]); }
    if (L.extra === 'beard') ball(head, hair, [0, -0.07, 0.035], 0.085, [1, 0.65, 0.9]);
    if (L.extra === 'headphones') { const hm = std(0x1a1a1a, { roughness: 0.4 }); mesh(new THREE.TorusGeometry(0.118, 0.012, 8, 24, Math.PI), hm, head).position.y = 0.01; for (const s of [-1, 1]) ball(head, std(L.mug || '#e3b26a', { roughness: 0.4 }), [0.112 * s, 0.0, 0.0], 0.04, [0.55, 1, 1]); }
    const arms = {}, hands = {};
    for (const [side, s] of [['L', 1], ['R', -1]]) {
      const sh = new THREE.Group(); spine.add(sh); sh.position.set(RIG.shoulderX * s, RIG.shoulderY, 0);
      rod(sh, shirt, [0, 0.02, 0], [0, -RIG.upperArm, 0], 0.05);
      const el = new THREE.Group(); sh.add(el); el.position.y = -RIG.upperArm; ball(el, shirt, [0, 0, 0], 0.048);
      rod(el, L.top === 'hoodie' || L.top === 'suit' ? shirt : skin, [0, 0, 0], [0, -0.24, 0], 0.041);
      const hand = new THREE.Group(); el.add(hand); hand.position.y = -RIG.forearm;
      ball(hand, skin, [0, 0, 0], 0.044, [0.85, 1.1, 0.7]);
      arms[side] = { sh, el }; hands[side] = hand;
    }
    const legs = {};
    for (const [side, s] of [['L', 1], ['R', -1]]) {
      const hip = new THREE.Group(); pelvis.add(hip); hip.position.set(0.085 * s, -0.02, 0);
      rod(hip, pants, [0, 0, 0], [0, -0.43, 0], 0.07);
      const knee = new THREE.Group(); hip.add(knee); knee.position.y = -0.43; ball(knee, pants, [0, 0, 0], 0.062);
      rod(knee, pants, [0, 0, 0], [0, -0.42, 0], 0.057);
      block(knee, shoe, [0, -0.455, 0.045], [0.1, 0.07, 0.25]);
      legs[side] = { hip, knee };
    }
    root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    return { root, pelvis, spine, neck, head, arms, hands, legs };
  }

  const tagFor = {};
  const people = [];
  const byId = {};
  function makeWorker(def, deskKey, isLead) {
    const fig = buildPerson(def.look);
    scene.add(fig.root);
    const w = {
      id: def.id, name: def.name, deskName: def.name, role: def.role, color: def.color || '#cccccc', skills: (def.skills || []).map(normSkill), floater: !!def.floater, lead: !!isLead,
      desk: deskKey, fig, pos: SPOTS[deskKey].pos.clone(), yaw: SPOTS[deskKey].yaw, speed: 1.2 + Math.random() * 0.25,
      pose: Object.assign({}, POSE.sit), target: POSE.sit, typePose: typePoseFor((def.look || {}).height || 1), route: {}, armR: null, seated: true, spot: deskKey,
      steps: [], step: null, doing: 'At their desk', mode: 'idle', task: null, waiting: null, carry: null, sessionId: null,
      walkPhase: Math.random() * 6, swivel: 0, swivelTo: 0, gaze: 0, gazeTo: 0, fidget: null, moving: false, rush: false, history: [], bubbleUntil: 0, nextSip: 0, sipUntil: 0,
      look: def.look || {}
    };
    SPOTS[deskKey].by = w.id;
    w.mug = mugMesh((def.look || {}).mug); w.mug.visible = false; fig.hands.R.add(w.mug);
    w.phone = block(fig.hands.R, std(0x15171a, { roughness: 0.3 }), [0, -0.03, 0.03], [0.07, 0.14, 0.012]); w.phone.visible = false;
    w.paddle = paddleMesh(Math.random() < 0.5 ? 0xc0392b : 0x222222); w.paddle.visible = false; fig.hands.R.add(w.paddle);
    DESKS[deskKey].mug.visible = Math.random() < 0.5;
    DESKS[deskKey].worker = w;
    const tag = document.createElement('div'); tag.className = 'tag'; tag.style.setProperty('--c', w.color);
    tag.innerHTML = '<i></i><b></b><em></em><span></span>'; tag.querySelector('b').textContent = w.name; tagLayer.appendChild(tag);
    tag.addEventListener('click', () => pickWorker(w));
    const bub = document.createElement('div'); bub.className = 'bubble'; bub.hidden = true; tagLayer.appendChild(bub);
    tagFor[w.id] = { tag, bub, span: tag.querySelector('span'), named: tag.querySelector('em') };
    people.push(w); byId[w.id] = w;
    return w;
  }
  function normSkill(s) { return String(s || '').trim().replace(/^\//, '').split(':').pop().toLowerCase(); }

  const deskOrder = ['a1', 'a2', 'b1', 'a0', 'b2', 'a3', 'b0', 'b3'];
  const lead = makeWorker(ROSTER.lead, 'lead', true);
  (ROSTER.workers || []).slice(0, deskOrder.length).forEach((def, i) => makeWorker(def, deskOrder[i]));
  people.forEach((w) => placeFigure(w));

  // ---------- events and the run API's plumbing ----------
  const events = []; let seq = 0; const listeners = new Map();
  let worldT = 0, speed = 1;
  const clockText = () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  function emit(type, data, source) {
    const e = Object.assign({ seq: ++seq, type, t: +worldT.toFixed(2), clock: clockText(), source: source || 'world' }, data || {});
    events.push(e); if (events.length > 5000) events.splice(0, events.length - 5000);
    for (const k of [type, '*']) (listeners.get(k) || []).slice().forEach((cb) => { try { cb(e); } catch (err) { console.error(err); } });
    return e;
  }
  function on(type, cb) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(cb); return () => { const l = listeners.get(type); const i = l.indexOf(cb); if (i >= 0) l.splice(i, 1); }; }

  // ---------- plans: what a person does, step by step ----------
  function reserve(key, w) { const s = SPOTS[key]; if (s) s.by = w.id; }
  function release(w) { if (w.spot && SPOTS[w.spot] && SPOTS[w.spot].by === w.id && w.spot !== w.desk) SPOTS[w.spot].by = null; }
  const free = (key) => SPOTS[key] && !SPOTS[key].by;
  function goTo(w, key, act, label) {
    w.steps = []; w.step = null;
    if (w.seated) w.steps.push({ t: 'stand' });
    if (w.spot !== key) { if (!w.seated) release(w); reserve(key, w); }
    w.steps.push({ t: 'walk', key }, { t: 'face', key });
    if (SPOTS[key].sit) w.steps.push({ t: 'sit', key });
    if (act) w.steps.push(act);
    w.doing = label || w.doing;
  }
  function act(o) { return Object.assign({ t: 'act', dur: 20, pose: 'stand' }, o); }
  function chooseIdle(w) {
    if (w.mode === 'work') return;
    if (w.waiting && w.seated && w.spot === w.desk) { w.steps.push(act({ dur: 5, pose: 'sit' })); return; }  // they stay until you answer
    if (boss.present) { looksBusy(w); return; }
    if (party.on && !party.ending && !reduce && joinParty(w)) return;
    const opts = [];
    const add = (weight, fn) => { if (weight > 0) opts.push([weight, fn]); };
    if (!w.carry && free('espresso')) add(2.4, () => coffeeRun(w));
    const couch = ['couch-0', 'couch-1', 'couch-2'].filter(free);
    if (couch.length) add(1.6, () => goTo(w, pick(couch), act({ dur: rand(20, 40), pose: pick(['couch', 'couch', 'couchBack']), prop: 'phone', label: 'On the couch' }), 'Going to the couch'));
    if (free('armchair')) add(0.6, () => goTo(w, 'armchair', act({ dur: rand(20, 40), pose: 'couch', prop: 'phone', label: 'In the armchair' }), 'Going to the armchair'));
    const wins = ['win-0', 'win-1', 'win-2'].filter(free);
    if (wins.length) add(1.2, () => goTo(w, pick(wins), act({ dur: rand(12, 25), pose: 'pockets', label: 'Looking out the window' }), 'Going to the window'));
    const bars = ['bar-w', 'bar-e', 'bar-s'].filter(free);
    if (bars.length) add(bars.length < 3 ? 2.2 : 1.0, () => goTo(w, pick(bars), act({ dur: rand(15, 30), pose: 'stand', chat: true, label: 'Chatting' }), 'Going to the bar table'));
    const boards = ['board-0', 'board-1'].filter(free);
    if (boards.length) add(0.6, () => goTo(w, pick(boards), act({ dur: rand(8, 16), pose: 'pockets', board: true, label: 'Reading the board' }), 'Going to the board'));
    if (free('fridge')) add(0.4, () => goTo(w, 'fridge', act({ dur: 4, pose: 'fridge', fridge: true, label: 'At the fridge' }), 'Going to the fridge'));
    if (!reduce && !party.on && free('pp-w') && free('pp-e') && !w.lead) {  // no new game during a party
      const partner = people.find((p) => p !== w && p.present && !p.lead && p.mode === 'idle' && !p.pingpong && p.step && p.step.t === 'act' && p.seated);
      if (partner) add(1.0, () => startPingPong(w, partner));
    }
    let total = opts.reduce((s, o) => s + o[0], 0), r = Math.random() * total;
    for (const [weight, fn] of opts) { if ((r -= weight) <= 0) { fn(); return; } }
    if (opts.length) opts[0][1]();
  }
  function coffeeRun(w) {
    goTo(w, 'espresso', act({ dur: 6, pose: 'brew', brew: true, label: 'Making coffee' }), 'Getting coffee');
    w.steps.push({ t: 'call', fn: () => { w.carry = 'mug'; withMug(w); } });
  }
  function withMug(w) {
    const r = Math.random();
    const bars = ['bar-w', 'bar-e', 'bar-s'].filter(free), wins = ['win-0', 'win-1', 'win-2'].filter(free);
    if (r < 0.35 && bars.length) goTo(w, pick(bars), act({ dur: rand(15, 30), pose: 'stand', chat: true, label: 'Coffee and a chat' }), 'Coffee and a chat');
    else if (r < 0.6 && wins.length) goTo(w, pick(wins), act({ dur: rand(14, 26), pose: 'stand', label: 'Coffee by the window' }), 'Coffee by the window');
    else if (bars.length || wins.length) { const k = pick(bars.concat(wins)); goTo(w, k, act({ dur: rand(14, 26), pose: 'stand', label: 'Having a coffee' }), 'Having a coffee'); }
    else w.steps.push(act({ dur: rand(10, 20), pose: 'stand', label: 'Having a coffee' }));
  }
  // ping pong: two idle people, one at each end
  const game = { a: null, b: null, live: false, t: 0, until: 0, hits: 0 };
  function startPingPong(a, b) {
    game.a = a; game.b = b; game.live = false; game.hits = 0; a.pingpong = b.pingpong = true;
    const dur = rand(25, 45);
    goTo(a, 'pp-w', act({ dur: Infinity, pose: 'ready', paddle: true, label: 'Playing ping pong' }), 'Playing ping pong');
    goTo(b, 'pp-e', act({ dur: Infinity, pose: 'ready', paddle: true, label: 'Playing ping pong' }), 'Playing ping pong');
    game.until = worldT + dur + 12;
  }
  function endPingPong() {
    if (!game.a) return;
    const pl = [game.a, game.b]; game.a = game.b = null; game.live = false; ppBall.visible = false;
    tablePaddles.forEach((p) => { p.visible = true; });
    pl.forEach((p) => { p.pingpong = false; p.paddle.visible = false; if (p.step && p.step.paddle) p.step.end = true; });
  }

  // ---------- who is in the room ----------
  // The first few people are always here. The rest come in for a session and leave after it.
  const STANDING = ['win-0', 'win-1', 'win-2', 'bar-w', 'bar-e', 'bar-s', 'board-0', 'board-1'];
  function placeAway(w) {  // somewhere in the room, on their feet, without the walk
    const k = pick(STANDING.filter(free));
    if (!k) return;
    if (w.spot !== w.desk) release(w);
    reserve(k, w);
    w.spot = k; w.seated = false; w.pos.copy(SPOTS[k].pos); w.yaw = SPOTS[k].yaw;
    w.pose = Object.assign({}, POSE.stand); w.target = POSE.stand; w.moving = false;
    w.steps = [act({ dur: rand(8, 20), pose: 'pockets', label: 'Looking around' })]; w.step = null; w.doing = 'Looking around';
    placeFigure(w);
  }
  function placeAtDesk(w) {  // already at work: a page that was just opened or reloaded
    if (w.spot !== w.desk) release(w);
    const sp = SPOTS[w.desk];
    w.spot = w.desk; w.seated = true; w.pos.copy(sp.pos); w.yaw = sp.yaw;
    w.pose = Object.assign({}, POSE.sit); w.target = POSE.sit; w.moving = false;
    w.steps = [act({ dur: Infinity, pose: 'type', work: true })]; w.step = null;
    placeFigure(w);
  }
  function showPerson(w) { w.present = true; w.fig.root.visible = true; placeAway(w); if (boss.present) looksBusy(w); markScreen(w); }
  function hidePerson(w) {
    if (w.pingpong) endPingPong();
    release(w);
    w.swivel = w.swivelTo = 0; w.gaze = w.gazeTo = 0; w.fidget = null;
    w.present = false; w.fig.root.visible = false; w.steps = []; w.step = null; w.spot = w.desk; w.seated = true; w.moving = false;
    tagFor[w.id].bub.hidden = true;
    markScreen(w);
  }

  // ---------- work ----------
  function assign(w, task, src) {
    if (!w.present) showPerson(w);
    if (w.pingpong) endPingPong();
    const handoff = w.task && w.task.label !== task.label ? w.task : null;
    task.since = worldT; task.startedAt = Date.now(); task.lastAt = Date.now(); task.lines = task.lines || [];
    w.task = task; w.mode = 'work'; w.waiting = null; w.rush = true;
    if (handoff) finishTask(w, handoff, 'replaced', src, true);
    if (w.carry === 'mug') { DESKS[w.desk].mug.visible = true; }
    if (w.spot === w.desk && w.seated) { w.steps = [act({ dur: Infinity, pose: 'type', work: true })]; w.step = null; }
    else goTo(w, w.desk, act({ dur: Infinity, pose: 'type', work: true }), 'Going to work');
    w.doing = 'Working on ' + task.label;
    line(w, task.first || ('start ' + task.label), 'start');
    bubble(w, task.label, 2.6);
    emit('worker.assigned', { who: w.id, name: w.name, skill: task.skill || null, label: task.label, session: task.session || null, agent: task.agent || null }, src);
    boardDirty = true; markScreen(w);
    return w;
  }
  function finishTask(w, task, reason, src, keepWorking) {
    const seconds = Math.round((Date.now() - task.startedAt) / 1000);
    done.unshift({ who: w.id, name: w.name, color: w.color, label: task.label, seconds, reason, at: clockText() }); if (done.length > 40) done.pop();
    w.history.unshift({ label: task.label, seconds, reason }); if (w.history.length > 20) w.history.pop();
    emit('worker.finished', { who: w.id, name: w.name, skill: task.skill || null, label: task.label, seconds, reason }, src);
    if (keepWorking) return;
  }
  function finish(w, reason, src) {
    if (!w.task) return false;
    const task = w.task; w.task = null; w.mode = 'idle'; w.rush = false;
    finishTask(w, task, reason || 'done', src);
    line(w, (reason === 'quiet' ? 'stopped: no activity' : 'done') + ' ' + task.label, 'done');
    bubble(w, reason === 'quiet' ? 'Nothing new, stopping' : 'Done', 2);
    w.steps = []; w.step = null;
    if (w.spot === w.desk && w.seated && !boss.present) w.steps.push(act({ dur: 5, pose: 'leanback', label: 'Wrapping up' }), act({ dur: 3, pose: 'stretch', label: 'Stretching' }));
    w.doing = 'Done: ' + task.label;
    if (w.extra && !w.sessionId) hidePerson(w);
    boardDirty = true; markScreen(w);
    return true;
  }
  const done = [];
  function line(w, text, kind) {
    const L = (w.task && w.task.lines) || (w.lines = w.lines || []);
    L.push({ text: String(text).slice(0, 90), kind: kind || 'tool', at: clockText() }); if (L.length > 60) L.splice(0, L.length - 60);
    if (w.task) w.task.lastAt = Date.now();
    markScreen(w);
  }
  function setWaiting(w, message) {
    w.waiting = message ? { message: String(message).slice(0, 100), since: Date.now(), startT: null } : null;
    if (!w.waiting && w.step) delete w.step.waveUntil;
    if (w.waiting) { bubble(w, 'Needs your OK', 4); if (w.step && w.step.t === 'act' && w.seated && w.spot !== w.desk) { w.step.waveUntil = worldT + 4; } }  // at the desk, fidgetOf starts with the wave
    emit(w.waiting ? 'lead.waiting' : 'lead.unblocked', w.waiting ? { who: w.id, message: w.waiting.message } : { who: w.id });
    boardDirty = true; markScreen(w);
  }

  // ---------- the manager ----------
  // Comes through the door now and then, looks around and over shoulders, then leaves. Not one
  // of `people`: no session or desk, not on the Floor list, and cannot be clicked. While the
  // manager is in, anyone without real work sits at their desk and looks busy. Real work is
  // never touched, so what a session is doing and showing stays true throughout.
  const M = ROSTER.manager || {};
  const DOOR = { x: 1.7, behind: -5.7, inside: -4.2, width: 1.0, height: 2.15 };
  const doorway = mesh(new THREE.PlaneGeometry(DOOR.width, DOOR.height), new THREE.MeshBasicMaterial({ color: C(0x08090b) }), scene, false);
  doorway.position.set(DOOR.x, DOOR.height / 2, -4.968);
  const doorFrame = std(0x2b2724, { roughness: 0.6 });
  for (const s of [-1, 1]) block(scene, doorFrame, [DOOR.x + s * (DOOR.width / 2 + 0.04), (DOOR.height + 0.08) / 2, -4.96], [0.08, DOOR.height + 0.08, 0.08]);
  block(scene, doorFrame, [DOOR.x, DOOR.height + 0.04, -4.96], [DOOR.width + 0.16, 0.08, 0.08]);
  const door = new THREE.Group(); door.position.set(DOOR.x - DOOR.width / 2, 0, -4.955); scene.add(door);
  block(door, std(0x3d4f45, { roughness: 0.5 }), [DOOR.width / 2, DOOR.height / 2, 0], [DOOR.width, DOOR.height, 0.04]);
  ball(door, metal(0xc9b37a, 0.3), [DOOR.width - 0.09, 1.02, 0.05], 0.03);
  const bossSpots = ['boss-aisle', 'boss-lounge', 'boss-board'];
  // the manager walks around the people sitting at desks, not through them
  const bossGrid = blocked.slice();
  for (const k in DESKS) for (let j = 0; j < GZ; j++) for (let i = 0; i < GX; i++) if (Math.hypot(cx(i) - DESKS[k].x, cz(j) - DESKS[k].z) < 0.55) bossGrid[j * GX + i] = 1;
  const bossFig = buildPerson(M.look); bossFig.root.visible = false; scene.add(bossFig.root);
  const boss = {
    id: 'manager', boss: true, grid: bossGrid, fig: bossFig, desk: null, spot: 'boss-door', pos: new THREE.Vector3(DOOR.x, 0, DOOR.behind), yaw: 0, speed: 1.05,
    pose: Object.assign({}, POSE.stand), target: POSE.stand, seated: false, route: {}, steps: [], step: null, doing: '', mode: 'work', task: null, waiting: null, carry: null,
    walkPhase: 0, swivel: 0, swivelTo: 0, gaze: 0, gazeTo: 0, fidget: null, moving: false, rush: false, bubbleUntil: 0, nextSip: 0, sipUntil: 0, present: false,
    mug: { visible: false }, phone: { visible: false }, paddle: { visible: false }  // nothing in hand
  };
  { const bub = document.createElement('div'); bub.className = 'bubble'; bub.hidden = true; tagLayer.appendChild(bub); tagFor[boss.id] = { bub }; }
  const bossGap = (share) => { const [a, b] = M.everyMinutes || []; return a > 0 ? worldT + rand(a, b || a) * 60 * share : Infinity; };
  let bossDue = bossGap(0.5);
  // Someone who was up to something leaves it as they would have found it.
  function leaveAppliance(w) {
    const s = w.step; if (!s) return;
    if (s.fridge) fridgeDoor.rotation.y = 0;
    if (s.brew) { brewMug.visible = false; espLight.material.emissiveIntensity = 0; steamOn = false; }
  }
  function looksBusy(w) {
    if (!w.present || w.task || w.waiting) return false;
    if (w.pingpong) endPingPong();
    leaveAppliance(w);
    const a = act({ dur: Infinity, pose: 'type', work: true, fake: true, label: 'Looking busy' });
    w.busyAct = a; w.rush = true;
    if (w.spot === w.desk && w.seated) { w.steps = [a]; w.step = null; } else goTo(w, w.desk, a, 'Hurrying to their desk');
    return true;
  }
  function bossStop(key, pose, dur, extra) { return [{ t: 'walk', key }, { t: 'face', key }, act(Object.assign({ dur, pose }, extra))]; }
  function bossRemark() { if (Math.random() < 0.55) bubble(boss, pick(['Hm.', 'Interesting.', 'Love the energy.', 'Keep it up.', 'Is that the Q3 deck?', 'Let\'s circle back.', 'Good, good.']), 2.6); }
  function bossVisit(src) {
    boss.present = true; boss.fig.root.visible = true; boss.spot = 'boss-door';
    boss.pos.set(DOOR.x, 0, DOOR.behind); boss.yaw = 0; boss.moving = false; boss.step = null;
    const desks = people.filter((p) => p.present).map((p) => p.desk).sort(() => Math.random() - 0.5).slice(0, 2 + Math.floor(Math.random() * 2));
    const looks = bossSpots.slice().sort(() => Math.random() - 0.5);
    boss.steps = [
      act({ dur: 1.2, pose: 'stand' }),  // the door opens, and people get a moment to scatter
      { t: 'walk', key: 'boss-door', path: [new THREE.Vector3(DOOR.x, 0, DOOR.inside)] },
      ...bossStop(looks[0], 'behindBack', rand(3, 6), { scan: true })
    ];
    for (const k of desks) boss.steps.push({ t: 'walk', key: 'boss-behind-' + k }, { t: 'face', key: 'boss-behind-' + k }, { t: 'call', fn: bossRemark }, act({ dur: rand(4, 8), pose: 'lookOver' }));
    boss.steps.push(...bossStop(looks[1], 'behindBack', rand(3, 6), { scan: true }), { t: 'walk', key: 'boss-door' }, { t: 'walk', key: 'boss-door', path: [new THREE.Vector3(DOOR.x, 0, DOOR.behind)] });
    const startled = people.filter(looksBusy);
    if (startled.length) bubble(pick(startled), pick(['Manager!', 'Look busy!', 'Heads up']), 1.8);
    emit('manager.arrived', {}, src);
  }
  function bossLeft() {
    boss.present = false; boss.fig.root.visible = false; boss.moving = false; boss.step = null; tagFor[boss.id].bub.hidden = true;
    bossDue = bossGap(1);
    for (const p of people) {
      if (!p.busyAct) continue;
      if (!p.task) { p.rush = false; p.busyAct.dur = (p.busyAct.el || 0) + rand(1, 6); }  // they wait a moment to be sure
      p.busyAct = null;
    }
    emit('manager.left', {});
  }
  function tickBoss(dt) {
    const open = boss.present && Math.hypot(boss.pos.x - DOOR.x, boss.pos.z + 5) < 1.7 ? -1.35 : 0;
    door.rotation.y += (open - door.rotation.y) * Math.min(1, dt * 5);
    if (!boss.present) { if (worldT >= bossDue && !party.on && !directed) bossVisit('world'); return; }  // the manager does not walk in on a party, or on the trailer
    if (!boss.step && !boss.steps.length) { bossLeft(); return; }
    tickWorker(boss, dt);
  }

  // Sends people with no real work to these spots, one each, to do actFor(spot) there. Someone
  // working, waiting on you or playing ping pong stays where they are. The huddle and the party use it.
  function gather(keys, actFor, label, skip) {
    const spots = keys.filter(free), gathered = [];
    for (const w of people) {
      if (!spots.length) break;
      if (!w.present || w.task || w.waiting || w.mode === 'work' || w.pingpong || (skip && skip(w))) continue;
      leaveAppliance(w);
      const k = spots.shift();
      goTo(w, k, actFor(k), label);
      w.step = null; gathered.push(w.id);
    }
    return gathered;
  }

  // ---------- the party ----------
  // Only a view: no session is stopped, paused or sent text, and tags, the Floor and the boards keep
  // the real state. Everyone, the manager too, wears a hat on their head, so it turns and sits with
  // them. A cake stands on the coffee table and people with no real work gather round it. After a
  // minute, or when the button is pressed again, the candles go out, the hats come off and everyone
  // goes back to their desk. Someone working or waiting on you stays at their desk, in a hat.
  const PARTY_SECONDS = 60, BLOW_SECONDS = 2.5;
  const party = { on: false, ending: false, until: 0, endAt: 0 };
  const CAKE_AT = new THREE.Vector3(5.305, 0.425, 2.2);  // on the coffee table, between the book and the mug
  const towardCake = (x, z) => Math.atan2(CAKE_AT.x - x, CAKE_AT.z - z);
  // Standing places round the coffee table, clear of the couch, the armchair and the table itself.
  [[4.95, 2.95], [5.6, 2.95], [4.3, 2.1], [6.3, 2.35], [5.25, 3.35], [4.6, 3.3], [5.95, 3.3], [6.3, 1.85]].forEach(([x, z], i) => {
    spot('party-' + i, x, z, towardCake(x, z), { label: 'At the party' }); SPOTS['party-' + i].approach = SPOTS['party-' + i].pos.clone(); SPOTS['party-' + i].by = null;
  });
  const PARTY_SPOTS = ['couch-1', 'party-0', 'party-1', 'couch-0', 'couch-2', 'party-2', 'party-3', 'party-4', 'party-5', 'party-6', 'party-7', 'armchair'];
  const partyAct = (k) => act({ dur: Infinity, pose: SPOTS[k].sit ? 'couch' : 'stand', chat: !SPOTS[k].sit, party: true, label: 'At the party' });
  function joinParty(w) {
    const k = PARTY_SPOTS.find(free);
    if (!k) return false;
    goTo(w, k, partyAct(k), 'Going to the party');
    return true;
  }
  const atParty = (w) => !!((w.step && w.step.party) || w.steps.some((s) => s.party));

  const HAT_COLORS = [['#e74c3c', '#ffd23f'], ['#3498db', '#ffffff'], ['#2ecc71', '#ff7eb6'], ['#9b59b6', '#ffd23f'], ['#ff8c1a', '#3498db'], ['#ff7eb6', '#ffffff']];
  const hatMats = HAT_COLORS.map(([a, b]) => {
    const c = makeCanvas(64, 64), x = c.getContext('2d');
    x.fillStyle = a; x.fillRect(0, 0, 64, 64); x.strokeStyle = b; x.lineWidth = 7;
    for (let i = -64; i < 128; i += 21) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i + 40, 64); x.stroke(); }  // stripes that wind round the cone
    return { cone: new THREE.MeshStandardMaterial({ map: tex(c), roughness: 0.6 }), pom: std(b, { roughness: 0.9 }) };
  });
  const hatGeo = new THREE.ConeGeometry(0.064, 0.19, 20);
  const HAIR_TOP = { bald: 0.105, buzz: 0.115, beanie: 0.135, curly: 0.135 };
  function putHatOn(fig, look, i) {
    const m = hatMats[i % hatMats.length], hat = new THREE.Group();
    hat.position.y = HAIR_TOP[(look || {}).hairStyle] || 0.125; hat.rotation.z = (i % 2 ? 1 : -1) * 0.12; hat.rotation.x = -0.08;
    const cone = mesh(hatGeo, m.cone, hat); cone.position.y = 0.095;
    ball(hat, m.pom, [0, 0.195, 0], 0.025);
    hat.visible = false; fig.head.add(hat);
    return hat;
  }
  people.forEach((w, i) => { w.hat = putHatOn(w.fig, w.look, i); });
  boss.hat = putHatOn(boss.fig, M.look, people.length);

  const cake = new THREE.Group(); cake.position.copy(CAKE_AT); cake.visible = false; scene.add(cake);
  cyl(cake, std(0xf4f1ea, { roughness: 0.3 }), [0, 0.006, 0], 0.13, 0.012);
  cyl(cake, std(0xf6c1d1, { roughness: 0.75 }), [0, 0.057, 0], 0.105, 0.09);
  cyl(cake, std(0xfffaf2, { roughness: 0.6 }), [0, 0.105, 0], 0.107, 0.012);
  for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; ball(cake, std(0xfffaf2, { roughness: 0.6 }), [Math.cos(a) * 0.1, 0.108, Math.sin(a) * 0.1], 0.013); }
  for (let i = 0; i < 9; i++) { const a = i * 2.4; ball(cake, std(['#e74c3c', '#3498db', '#2ecc71', '#ffd23f'][i % 4], { roughness: 0.5 }), [Math.cos(a) * 0.05 * (i % 3) / 2, 0.113, Math.sin(a) * 0.05 * (i % 3) / 2], 0.006); }
  const flameMat = new THREE.MeshBasicMaterial({ color: C(0xffb340), toneMapped: false }), smokeMat = new THREE.MeshBasicMaterial({ color: 0xcfcfcf, transparent: true, opacity: 0, depthWrite: false });
  const candles = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3, x = Math.cos(a) * 0.065, z = Math.sin(a) * 0.065;
    cyl(cake, std(HAT_COLORS[i][0], { roughness: 0.5 }), [x, 0.14, z], 0.006, 0.055);
    const flame = ball(cake, flameMat, [x, 0.18, z], 0.011, [0.7, 1.6, 0.7]); flame.castShadow = false;
    const smoke = ball(cake, smokeMat, [x, 0.19, z], 0.012); smoke.castShadow = false; smoke.visible = false;
    candles.push({ flame, smoke, x, z, phase: i * 1.7 });
  }
  cake.traverse((o) => { if (o.isMesh) o.castShadow = false; });

  function wearHats(on) { for (const p of people.concat(boss)) p.hat.visible = on; }
  function startParty(src, seconds) {
    Object.assign(party, { on: true, ending: false, until: worldT + seconds, endAt: 0 });
    wearHats(true); cake.visible = true;
    candles.forEach((c) => { c.flame.visible = true; c.smoke.visible = false; });
    let gathered = [];
    if (!reduce && !boss.present) {
      for (const w of people) if (w.pingpong && !w.task && !w.waiting) { endPingPong(); break; }
      for (const w of people) {  // someone already on the couch or in the armchair stays there for the party
        if (!w.present || w.task || w.waiting || w.mode === 'work' || !w.seated || w.spot === w.desk || !PARTY_SPOTS.includes(w.spot) || atParty(w) || (w.step && w.step.t !== 'act')) continue;
        w.steps = [partyAct(w.spot)]; w.step = null; gathered.push(w.id);
      }
      gathered = gathered.concat(gather(PARTY_SPOTS, partyAct, 'Going to the party', atParty));  // pressed again while it ends, the guests stay put
    }
    const host = people.find((w) => gathered.includes(w.id)) || people.find((w) => w.present);
    if (host) bubble(host, pick(['Party!', 'Cake!', 'Hats on, everyone']), 2.6);
    emit('party.started', { gathered, seconds }, src);
  }
  // The candles go out first, and a moment later the hats come off and everyone goes back.
  function endParty(src) {
    party.ending = true; party.endAt = worldT + BLOW_SECONDS;
    candles.forEach((c) => { c.flame.visible = false; c.smoke.visible = true; c.smoke.position.set(c.x, 0.19, c.z); });
    smokeMat.opacity = 0.5;
    const guest = people.find((w) => w.present && w.step && w.step.party);
    if (guest) bubble(guest, pick(['Make a wish!', 'Hooray!', 'Speech!']), 2.2);
    emit('party.ending', {}, src);
  }
  function partyOver() {
    Object.assign(party, { on: false, ending: false, until: 0, endAt: 0 });
    wearHats(false); cake.visible = false;
    const home = [];
    for (const w of people) {
      if (!w.present || w.task || w.waiting || w.mode === 'work' || !atParty(w)) continue;
      goTo(w, w.desk, act({ dur: rand(15, 30), pose: 'leanback', label: 'At their desk' }), 'Going back to their desk');
      w.step = null; home.push(w.id);
    }
    emit('party.ended', { home });
  }
  function tickParty() {
    if (!party.on) return;
    if (!party.ending && worldT >= party.until) endParty('world');
    if (party.ending) {
      const k = 1 - Math.max(0, party.endAt - worldT) / BLOW_SECONDS;
      smokeMat.opacity = Math.max(0, 0.5 * (1 - k));
      if (!reduce) candles.forEach((c) => { c.smoke.position.y = 0.19 + k * 0.25; c.smoke.scale.setScalar(0.012 + k * 0.03); });
      if (worldT >= party.endAt) partyOver();
      return;
    }
    if (!reduce) candles.forEach((c) => { const f = 1 + Math.sin(worldT * 17 + c.phase) * 0.12 + Math.sin(worldT * 29 + c.phase) * 0.08; c.flame.scale.set(0.0077 * f, 0.0176 * f, 0.0077 * f); });
  }
  function partyState() {
    return { on: party.on, ending: party.ending, secondsLeft: party.on && !party.ending ? Math.max(0, Math.ceil(party.until - worldT)) : 0, guests: people.filter((w) => w.present && atParty(w)).map((w) => w.id) };
  }

  // ---------- each frame: plans, walking and poses ----------
  // Waiting for your OK at their desk: they stay in the chair and pass the time. The hand goes up
  // first and comes back round, so someone on their phone can still be spotted.
  const FIDGETS = [['phone', 8], ['swivel', 7], ['wave', 2.5], ['leanback', 6], ['look', 5], ['wave', 2.5]];
  const FIDGET_LOOP = FIDGETS.reduce((n, f) => n + f[1], 0), FIRST_WAVE = 4;
  const FIDGET_POSE = { phone: 'phoneSit', swivel: 'sit', wave: 'wave', leanback: 'leanback', look: 'sit' };
  function fidgetOf(w) {
    if (w.waiting.startT === null) w.waiting.startT = worldT;  // the wait starts showing once they are in the chair
    const t = worldT - w.waiting.startT;
    if (t < FIRST_WAVE) return 'wave';
    let at = (t - FIRST_WAVE + w.walkPhase * 7) % FIDGET_LOOP;  // people waiting together do not move as one
    for (const [name, dur] of FIDGETS) { if (at < dur) return name; at -= dur; }
    return 'wave';
  }

  const tmp = new THREE.Vector3();
  function tickWorker(w, dt) {
    const fidgeting = w.fidget;
    w.swivelTo = 0; w.gazeTo = 0; w.fidget = null;
    if (!w.step) {
      w.step = w.steps.shift() || null;
      if (!w.step) { if (w.mode === 'work') { w.step = act({ dur: Infinity, pose: 'type', work: true }); } else { chooseIdle(w); w.step = w.steps.shift() || act({ dur: 5, pose: w.seated ? 'sit' : 'stand' }); } }
      startStep(w, w.step);
    }
    const s = w.step; s.el = (s.el || 0) + dt;
    switch (s.t) {
      case 'stand': {
        const sp = SPOTS[w.spot];
        w.target = POSE.stand; w.seated = false;
        if (sp) { const k = Math.min(1, s.el / 0.55); w.pos.lerpVectors(sp.pos, sp.approach, k); }
        if (s.el >= 0.55) nextStep(w);
        break;
      }
      case 'walk': {
        if (!s.path) { s.path = findPath(w.pos, SPOTS[s.key].approach, w.grid); release(w); w.spot = s.key; }
        const target = s.path[0];
        if (!target) { nextStep(w); break; }
        tmp.subVectors(target, w.pos); tmp.y = 0;
        const d = tmp.length(), v = w.speed * (w.rush ? 3.2 : 1) * dt;  // a turn can be over in seconds
        if (d < 0.02 || d <= v) { w.pos.copy(target); w.pos.y = 0; s.path.shift(); if (!s.path.length) { w.moving = false; nextStep(w); } }
        else { w.pos.addScaledVector(tmp.normalize(), v); w.moving = true; w.walkPhase += (v / 1.15) * Math.PI * 2; turnTo(w, Math.atan2(tmp.x, tmp.z), dt, 9); }
        w.target = POSE.stand;
        break;
      }
      case 'face': {
        const yaw = SPOTS[s.key].yaw; turnTo(w, yaw, dt, 7);
        if (Math.abs(angDiff(w.yaw, yaw)) < 0.05 || s.el > 1.2) { w.yaw = yaw; nextStep(w); }
        break;
      }
      case 'sit': {
        const sp = SPOTS[s.key], k = Math.min(1, s.el / 0.6);
        w.pos.lerpVectors(sp.approach, sp.pos, k); w.target = sp.sit === 'couch' ? POSE.couchBack : POSE.sit; w.seated = true;
        if (s.el >= 0.6) nextStep(w);
        break;
      }
      case 'act': {
        let pose = s.pose === 'type' ? w.typePose : POSE[s.pose] || POSE.stand;
        if (s.waveUntil && worldT < s.waveUntil) pose = POSE.wave;
        if (w.waiting && w.seated && w.spot === w.desk) {
          w.fidget = fidgetOf(w);
          pose = POSE[FIDGET_POSE[w.fidget]];
          w.phone.visible = w.fidget === 'phone' && !w.carry;
          if (!reduce && w.fidget === 'swivel') w.swivelTo = Math.sin(worldT * 0.9 + w.walkPhase) * 0.55;
          if (!reduce && w.fidget === 'look') w.gazeTo = Math.sin(worldT * 0.7 + w.walkPhase) * 0.7;
        } else {
          if (fidgeting) w.phone.visible = phoneWanted(w, s);  // however the wait ended
          if (w.waiting && w.seated && Math.sin(worldT * 0.9) > 0.3) pose = POSE.wave;
        }
        if (s.board && Math.sin(s.el * 0.7 + 1) > 0.55) pose = POSE.point;
        w.target = pose;
        if (s.brew) brewTick(w, s);
        if (s.fridge) fridgeDoor.rotation.y = -Math.min(1.4, Math.sin(Math.min(Math.PI, (s.el / s.dur) * Math.PI)) * 2.2);
        if (s.end || (s.el >= s.dur)) { if (s.fridge) fridgeDoor.rotation.y = 0; nextStep(w); }
        break;
      }
      case 'call': s.fn(); nextStep(w); break;
      default: nextStep(w);
    }
  }
  const phoneWanted = (w, s) => !w.carry && (s.prop === 'phone' || (s.prop === 'phone?' && s.pose === 'phoneSit'));
  function startStep(w, s) {
    if (s.t === 'act') {
      if (s.label) w.doing = s.label;
      if (s.work && !s.fake) w.doing = 'Working on ' + (w.task ? w.task.label : 'something');
      w.phone.visible = phoneWanted(w, s);
      if (s.paddle) { w.paddle.visible = true; tablePaddles.forEach((p) => { p.visible = false; }); }
      if (w.seated && w.spot === w.desk && w.carry === 'mug' && (s.work || Math.random() < 0.5)) { w.carry = null; DESKS[w.desk].mug.visible = true; }
      if (s.dur === Infinity && s.paddle && game.a && game.b && game.a.step && game.b.step && game.a.step.paddle && game.b.step.paddle) { game.live = true; game.t = 0; ppBall.visible = true; }
      if (!w.boss) emit('worker.doing', { who: w.id, doing: w.doing });
    } else { w.phone.visible = false; }
  }
  function nextStep(w) { w.step = null; }
  function turnTo(w, yaw, dt, rate) { w.yaw += angDiff(w.yaw, yaw) * Math.min(1, dt * rate); }

  function brewTick(w, s) {
    const k = s.el / s.dur;
    espLight.material.emissiveIntensity = k < 0.9 ? 2.5 : 0;
    brewMug.visible = k > 0.15 && k < 0.95;
    steamOn = k > 0.15 && k < 0.85;
    if (k >= 0.95) { brewMug.visible = false; espLight.material.emissiveIntensity = 0; steamOn = false; }
  }
  let steamOn = false;
  function tickSteam(dt) {
    for (const p of steam) {
      p.t += dt * 0.6; if (p.t > 1) { p.t -= 1; }
      const on = steamOn || p.m.material.opacity > 0.01;
      p.m.visible = on;
      if (!on) continue;
      p.m.position.set(4.35 + Math.sin(p.t * 7 + p.t) * 0.03, 1.15 + p.t * 0.5, -4.5 + Math.cos(p.t * 5) * 0.02);
      p.m.scale.setScalar(0.03 + p.t * 0.07);
      p.m.material.opacity = steamOn ? (1 - p.t) * 0.3 : Math.max(0, p.m.material.opacity - dt);
    }
  }
  function tickGame(dt) {
    if (!game.a) return;
    if (worldT > game.until) { const a = game.a; endPingPong(); bubble(a, pick(['Good game', 'Rematch later', '21 to 19']), 2); return; }
    if (!game.live) {
      if (game.a.step && game.b.step && game.a.step.paddle && game.b.step.paddle) { game.live = true; game.t = 0; ppBall.visible = true; }
      return;
    }
    game.t += dt * 0.85;
    const leg = Math.floor(game.t), u = game.t - leg, dir = leg % 2 ? -1 : 1;
    const x0 = -0.6 - 1.62 * dir, x1 = -0.6 + 1.62 * dir;
    const x = x0 + (x1 - x0) * u, bounceU = 0.62;
    const y = u < bounceU ? 0.77 + Math.sin((u / bounceU) * Math.PI) * 0.32 + (1 - u / bounceU) * 0.12 : 0.77 + Math.sin(((u - bounceU) / (1 - bounceU)) * Math.PI) * 0.28;
    ppBall.position.set(x, y + 0.02, 3.4 + Math.sin(game.t * 1.7) * 0.35);
  }

  function placeFigure(w) {
    const f = w.fig;
    f.root.position.set(w.pos.x, 0, w.pos.z); f.root.rotation.y = w.yaw + w.swivel;
  }
  const upQ = new THREE.Quaternion(), tq = new THREE.Quaternion(), te = new THREE.Euler();
  function applyPose(w, dt) {
    const p = w.pose, t = w.target, k = Math.min(1, dt * (w.moving ? 10 : 7));
    w.swivel += (w.swivelTo - w.swivel) * Math.min(1, dt * 3);
    w.gaze += (w.gazeTo - w.gaze) * Math.min(1, dt * 3);
    if (w.desk) DESKS[w.desk].chair.rotation.y = w.swivel;  // the manager has no desk
    let armR = null;
    if (w.carry === 'mug' && !(w.step && w.step.brew)) {
      armR = w.seated ? ARM_CARRY_SIT : ARM_CARRY;
      if (!w.moving && worldT > w.nextSip) { w.sipUntil = worldT + 1.3; w.nextSip = worldT + rand(5, 11); }
      if (worldT < w.sipUntil) armR = ARM_SIP;
    }
    if (w.paddle.visible) armR = ARM_PADDLE;
    let aim = armR ? Object.assign({}, t, armR) : t;
    const seat = w.seated && SPOTS[w.spot] && SPOTS[w.spot].seat;
    if (seat) aim = Object.assign({}, aim, seatOn(aim, seat, (w.look || {}).height));  // on the couch or the armchair, not in it
    const ahead = w.desk && w.spot === w.desk && !w.moving ? w.pos.distanceTo(SPOTS[w.desk].pos) : Infinity;
    if (w.seated ? ahead < Infinity : ahead < 0.03) aim = aimArms(w.route, p, aim, w.look.height || 1, ahead);  // in the chair, or sitting down
    else if (w.route.L || w.route.R) w.route = {};
    towards(p, aim, k);
    const f = w.fig, tt = worldT;
    let py = p.py, lean = p.lean, sLx = p.sLx, sRx = p.sRx, eL = p.eL, eR = p.eR, hipL = p.hipL, hipR = p.hipR, kL = p.kL, kR = p.kR, hx = p.hx, hy = p.hy + w.gaze, sRz = p.sRz, sLz = p.sLz;
    if (w.moving) {
      const ph = w.walkPhase, sw = Math.sin(ph);
      hipL += sw * 0.42; hipR -= sw * 0.42;
      kL += Math.max(0, Math.sin(ph + 1.9)) * 0.75; kR += Math.max(0, Math.sin(ph + 1.9 + Math.PI)) * 0.75;
      sLx -= sw * 0.32; if (!armR) sRx += sw * 0.32;
      py += Math.abs(Math.cos(ph)) * 0.025 - 0.02; lean += 0.05;
    } else {
      py += Math.sin(tt * 1.6 + w.walkPhase) * 0.004;
      const s = w.step;
      if (s && s.t === 'act' && s.work && w.seated && !w.fidget) {  // typing: the hands only lift, so they never sink into the desk
        eL -= Math.abs(Math.sin(tt * 8.5 + w.walkPhase)) * 0.07; eR -= Math.abs(Math.sin(tt * 9.75)) * 0.07;
        sLx -= (1 + Math.sin(tt * 6.1)) * 0.015; sRx -= (1 + Math.cos(tt * 5.3)) * 0.015;
        hy += Math.sin(tt * 0.4 + w.walkPhase) * 0.12;
      }
      if (s && s.t === 'act' && s.scan) hy += Math.sin(s.el * 0.9) * 0.7;
      if (s && s.t === 'act' && s.chat) { const talk = Math.sin(tt * 0.5 + w.walkPhase) > 0; if (talk) { eL += Math.sin(tt * 3.1) * 0.35 - 0.5; sLx -= 0.2; } hy += Math.sin(tt * 0.3 + w.walkPhase) * 0.25; }
      if (s && s.t === 'act' && s.paddle && game.live) {
        const mine = game.a === w ? 0 : 1, leg = Math.floor(game.t), u = game.t - leg, coming = (leg % 2) === mine ? 0 : 1;
        if (coming && u > 0.8) { sRz += (u - 0.8) * 4; sRx -= (u - 0.8) * 2; } hy += Math.sin(tt * 2) * 0.1;
      }
      if (w.fidget ? w.fidget === 'wave' : w.waiting && w.seated && Math.sin(tt * 0.9) > 0.3) sRz += Math.sin(tt * 9) * 0.35;
      if (s && s.waveUntil && tt < s.waveUntil) sRz += Math.sin(tt * 9) * 0.35;
    }
    f.pelvis.position.y = py;
    f.spine.rotation.x = lean;
    f.head.rotation.set(hx, hy, 0);
    f.arms.L.sh.rotation.set(sLx, 0, sLz); f.arms.L.el.rotation.x = eL;
    f.arms.R.sh.rotation.set(sRx, 0, -sRz); f.arms.R.el.rotation.x = eR;
    f.legs.L.hip.rotation.x = hipL; f.legs.L.knee.rotation.x = kL; f.legs.R.hip.rotation.x = hipR; f.legs.R.knee.rotation.x = kR;
    placeFigure(w);
    // a mug stays upright in the hand; while sipping it tips toward the mouth
    w.mug.visible = w.carry === 'mug';
    if (w.mug.visible) {
      f.root.updateMatrixWorld(true);
      w.fig.hands.R.getWorldQuaternion(tq);
      te.set(worldT < w.sipUntil ? -0.6 : 0, w.yaw + Math.PI / 2, 0); upQ.setFromEuler(te);
      w.mug.quaternion.copy(tq.invert().multiply(upQ));
      w.mug.position.set(0, -0.06, 0.035);
    }
    if (w.paddle.visible) { w.paddle.position.set(0, -0.03, 0.02); w.paddle.rotation.set(0, 0, 0); }
    if (w.phone.visible) { w.phone.rotation.set(-1.1, 0, 0); w.phone.position.set(-0.03, -0.04, 0.04); }
  }

  // ---------- monitors ----------
  const screenDirty = new Set();
  function markScreen(w) { screenDirty.add(w.desk); }
  const MONO = '"Roboto Mono", ui-monospace, monospace';
  const KIND_COLOR = { start: '#e3b26a', done: '#8fd19e', skill: '#c79be0', agent: '#7fd8d0', edit: '#8fd19e', read: '#8fb0e3', bash: '#e3b26a', web: '#c79be0', fail: '#f08c7e', tool: '#cfe9f7', prompt: '#ffffff', wait: '#f0c25e' };
  function drawScreen(sc, w, index, blink) {
    const x = sc.ctx, W = sc.canvas.width, H = sc.canvas.height;
    x.fillStyle = '#0d1117'; x.fillRect(0, 0, W, H);
    if (!w || !w.present) return;
    const working = !!w.task || !!w.waiting || (w.lead && index === 1 && leadLog.length);
    if (!working) {
      const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#111827'); g.addColorStop(1, '#1d2433'); x.fillStyle = g; x.fillRect(0, 0, W, H);
      x.globalAlpha = 0.18; x.fillStyle = w.color;
      for (let i = 0; i < 14; i++) x.fillRect(28 + (i % 3) * 18, 34 + i * 18, 60 + ((i * 53 + w.id.length * 31) % 260), 8);
      x.globalAlpha = 1; x.fillStyle = '#e6e6e6'; x.font = '600 50px ' + MONO; x.textAlign = 'right'; x.fillText(clockText().replace(/\s?[ap]m/, ''), W - 26, H - 70);
      x.font = '22px ' + MONO; x.fillStyle = w.color; x.fillText(w.name + (index ? ' · 2' : ''), W - 26, H - 34); x.textAlign = 'left';
      return;
    }
    x.fillStyle = '#1b222c'; x.fillRect(0, 0, W, 34);
    ['#f08c7e', '#f0c25e', '#8fd19e'].forEach((c, i) => { x.fillStyle = c; x.beginPath(); x.arc(18 + i * 18, 17, 6, 0, Math.PI * 2); x.fill(); });
    x.fillStyle = '#cfd6df'; x.font = '18px ' + MONO;
    const seated = w.sessionId && sessions.get(w.sessionId);
    const title = w.name.toLowerCase() + ' — ' + (w.task ? w.task.label : (seated && seated.title) || 'session');
    x.fillText(title.slice(0, 34), 76, 23);
    let lines = (w.task ? w.task.lines : []) || [];
    if (w.lead && sc === DESKS.lead.screens[1]) lines = leadLog;
    const rows = 11, shown = lines.slice(-rows);
    x.font = '17px ' + MONO;
    shown.forEach((l, i) => {
      const y = 62 + i * 21;
      x.fillStyle = '#5c6773'; x.fillText(l.kind === 'start' || l.kind === 'done' ? '●' : '›', 14, y);
      x.fillStyle = KIND_COLOR[l.kind] || '#cfe9f7'; x.fillText(l.text.slice(0, 44), 34, y);
    });
    const y = 62 + shown.length * 21;
    if (w.waiting) { x.fillStyle = '#f0c25e'; x.fillText('? ' + w.waiting.message.slice(0, 42), 14, Math.min(y, H - 40)); }
    else if (y < H - 10 && blink) { x.fillStyle = '#e6e6e6'; x.fillRect(34, y - 15, 10, 18); }
    if (w.task) {
      const secs = Math.round((Date.now() - w.task.startedAt) / 1000);
      x.fillStyle = 'rgba(13,17,23,0.85)'; x.fillRect(W - 132, H - 30, 132, 30);
      x.fillStyle = w.color; x.font = '16px ' + MONO; x.fillText('⠿ ' + fmtDur(secs), W - 120, H - 10);
    }
  }
  function fmtDur(s) { return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'; }
  const leadLog = [];
  function leadLine(text, kind) { leadLog.push({ text: String(text).slice(0, 90), kind: kind || 'tool' }); if (leadLog.length > 60) leadLog.splice(0, leadLog.length - 60); screenDirty.add('lead'); }
  let lastBlink = -1;
  function tickScreens() {
    const blink = Math.floor(performance.now() / 500) % 2 === 0, changed = blink !== lastBlink; lastBlink = blink;
    for (const key in DESKS) {
      const d = DESKS[key], w = d.worker;
      const busy = w && (w.task || w.waiting);
      if (!screenDirty.has(key) && !(busy && changed) && !(changed && clockMinChanged)) continue;
      d.screens.forEach((sc, i) => { drawScreen(sc, w, i, blink); sc.tex.needsUpdate = true; });
    }
    screenDirty.clear(); clockMinChanged = false;
  }
  let clockMinChanged = false;

  function fit(x, text, max) { let t = String(text); if (x.measureText(t).width <= max) return t; while (t.length > 1 && x.measureText(t + '…').width > max) t = t.slice(0, -1); return t + '…'; }
  function wrap(x, text, max, rows) {
    const out = []; let cur = '';
    for (const word of String(text).split(/\s+/)) {
      const next = cur ? cur + ' ' + word : word;
      if (x.measureText(next).width <= max || !cur) cur = next; else { out.push(cur); cur = word; }
    }
    if (cur) out.push(cur);
    if (out.length > rows) { out.length = rows; out[rows - 1] = fit(x, out[rows - 1] + ' …', max); }
    return out.map((t) => fit(x, t, max));
  }
  function drawBoard() {
    const x = boardC.getContext('2d'), W = boardC.width, H = boardC.height;
    x.fillStyle = '#f7f7f4'; x.fillRect(0, 0, W, H);
    const cols = taskList.length ? [['Building', 24], ['In review', 276], ['Waiting on you', 528], ['Done', 780]] : [['Doing', 24], ['Waiting on you', 364], ['Done', 704]];
    x.font = '600 30px "Source Sans 3", system-ui, sans-serif'; x.fillStyle = '#1d3f72';
    cols.forEach(([t, cx0]) => x.fillText(t, cx0, 46));
    x.strokeStyle = '#c9ccd1'; x.lineWidth = 2; (taskList.length ? [260, 512, 764] : [344, 684]).forEach((cx0) => { x.beginPath(); x.moveTo(cx0, 20); x.lineTo(cx0, H - 20); x.stroke(); });
    const sticky = (cx0, cy0, color, title, sub, i) => {
      const [r, g, b] = hexRGB(color);
      x.save(); x.translate(cx0 + 75, cy0 + 45); x.rotate(((i * 37) % 7 - 3) * 0.012);
      x.fillStyle = 'rgba(0,0,0,0.12)'; x.fillRect(-72, -40, 150, 90);
      x.fillStyle = 'rgb(' + Math.min(255, r + 40) + ',' + Math.min(255, g + 40) + ',' + Math.min(255, b + 40) + ')'; x.fillRect(-75, -45, 150, 88);
      x.fillStyle = '#1c1c1c'; x.font = '600 21px "Source Sans 3", system-ui, sans-serif'; x.fillText(fit(x, title, 132), -64, -16);
      x.font = '17px "Source Sans 3", system-ui, sans-serif'; x.fillStyle = '#333';
      wrap(x, sub, 132, 2).forEach((t, k) => x.fillText(t, -64, 8 + k * 19)); x.restore();
    };
    if (taskList.length) {  // the tasks are the board: one note for each, in its column
      const column = { building: 0, changes_requested: 0, in_review: 1, waiting_on_you: 2, done: 3 }, count = [0, 0, 0, 0];
      const put = (col, color, title, sub) => { const i = count[col]++; if (i < 4) sticky(cols[col][1], 70 + i * 104, color, title, sub, i + col); };
      taskList.forEach((t) => {
        const w = t.who && byId[t.who];
        // A task in review or waiting on you with a running or failed pipeline waits on the pipeline (relay/tasks.js).
        put(t.pipeline ? 0 : column[t.state] ?? 0, t.state === 'done' ? '#b5b5b5' : w ? w.color : '#8fb0e3', t.title, (t.pipeline ? (t.pipeline === 'red' ? 'Pipeline failed · ' : 'Pipeline · ') : t.state === 'changes_requested' ? 'Changes · ' : '') + (w ? w.name : 'No worker'));
      });
      people.filter((p) => p.waiting).forEach((p) => put(2, '#f0c25e', p.name + ' needs you', p.waiting.message));
      boardTex.needsUpdate = true;
      return;
    }
    const doing = people.filter((p) => p.task);
    doing.slice(0, 8).forEach((p, i) => sticky(24 + (i % 2) * 158, 70 + Math.floor(i / 2) * 104, p.color, p.task.label, p.name, i));
    people.filter((p) => p.waiting).slice(0, 4).forEach((p, i) => sticky(364, 70 + i * 104, '#f0c25e', p.name + ' needs you', p.waiting.message, i + 1));
    done.slice(0, 8).forEach((d, i) => sticky(704 + (i % 2) * 158, 70 + Math.floor(i / 2) * 104, '#b5b5b5', d.label, d.name + ' ✓ ' + fmtDur(d.seconds), i + 3));
    boardTex.needsUpdate = true;
  }
  let boardDirty = true, taskList = [];

  // ---------- name tags and speech bubbles ----------
  let showTags = true;
  const proj = new THREE.Vector3();
  function bubble(w, text, secs) { const b = tagFor[w.id].bub; b.textContent = text; b.hidden = false; w.bubbleUntil = performance.now() + (secs || 2.5) * 1000; }
  function tickTags() {
    const rect = canvas.getBoundingClientRect(), W = rect.width, H = rect.height, now = performance.now(), shown = [];
    for (const w of people) {
      const T = tagFor[w.id];
      w.fig.head.getWorldPosition(proj); proj.y += 0.3; proj.project(camera);
      const vis = proj.z < 1 && proj.x > -1.1 && proj.x < 1.1 && proj.y > -1.1 && proj.y < 1.1;
      const sx = (proj.x * 0.5 + 0.5) * W, sy = (-proj.y * 0.5 + 0.5) * H;
      const state = w.waiting ? 'wait' : w.task ? 'work' : 'idle';
      if (T.tag.dataset.state !== state) T.tag.dataset.state = state;
      const seated = w.sessionId && sessions.get(w.sessionId);
      const said = w.task ? w.task.label : seated ? seated.title || seated.project || seated.id : '';
      const what = seated && seated.customTitle && said === seated.customTitle ? seated.project || '' : said;  // not twice beside the name
      const sub = w.waiting ? 'needs you' + (what ? ' · ' + what : '') : what;
      if (T.span.textContent !== sub) { T.span.textContent = sub; T.span.title = sub; T.w = 0; }
      const named = window.OfficeSeats.titleBeside(seated && seated.customTitle);  // the title you gave it with /rename
      if (T.named.textContent !== named.text) { T.named.textContent = named.text; T.named.title = named.full; T.w = 0; }
      T.tag.hidden = !showTags || !vis || !w.present;
      if (!w.present) continue;
      if (!T.bub.hidden) {
        T.bub.hidden = now > w.bubbleUntil; T.bub.style.visibility = vis ? '' : 'hidden';
        placeAt(T.bub, sx, sy - 26);
      }
      if (T.tag.hidden) continue;
      if (!T.w) { T.w = T.tag.offsetWidth; T.h = T.tag.offsetHeight; }
      shown.push({ el: T.tag, bub: T.bub, x: sx, y: sy, w: T.w, h: T.h });
    }
    stackTags(shown);
    if (boss.present && !tagFor[boss.id].bub.hidden) {
      const b = tagFor[boss.id].bub;
      boss.fig.head.getWorldPosition(proj); proj.y += 0.3; proj.project(camera);
      b.hidden = now > boss.bubbleUntil;
      placeAt(b, (proj.x * 0.5 + 0.5) * W, (-proj.y * 0.5 + 0.5) * H);
    }
    for (const t of shown) {
      placeAt(t.el, t.x, t.y);
      if (!t.bub.hidden) placeAt(t.bub, t.x, t.y - 26);
    }
  }
  function placeAt(el, x, y) { el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) translate(-50%, -100%)'; }
  // Neighbouring desks land on almost the same spot, so a tag that would cover another moves up
  // above it, and the tag nearest the bottom of the screen stays on its person. If that pushes
  // any tag off the top of the stage, they stack downward from the top instead.
  // A tag's y is its bottom edge. Each move lands exactly on the limit it was tested against and
  // only goes one way, so a tag passes each neighbour once and the loop always ends.
  function stackTags(tags) {
    const clear = (t, placed, up) => {
      for (let moved = true; moved;) {
        moved = false;
        for (let i = 0; i < placed; i++) {
          const p = tags[i];
          if (Math.abs(t.x - p.x) >= (t.w + p.w) / 2 + 4) continue;
          const above = p.y - p.h - 2, below = p.y + t.h + 2;
          if (t.y > above && t.y < below) { t.y = up ? above : below; moved = true; }
        }
      }
    };
    tags.sort((a, b) => b.y - a.y);
    tags.forEach((t, i) => clear(t, i, true));
    if (!tags.some((t) => t.y < t.h)) return;
    tags.sort((a, b) => a.y - b.y);
    tags.forEach((t, i) => { t.y = Math.max(t.y, t.h); clear(t, i, false); });
  }
  // sizes are measured when a tag's text changes, and again once the web fonts have loaded
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { Object.values(tagFor).forEach((T) => { T.w = 0; }); });

  // ---------- Claude Code hooks ----------
  // The hook script (relay/office-hook.js) sends each hook event, trimmed, as {"action": "hook"}.
  // Fields: hook_event_name, session_id, project, tool_name, tool_input (short summary),
  // agent_id, agent_type, message, notification_type, title (what the session is about, once
  // Claude Code has named it), prompt (only if the user turned it on).
  const sessions = new Map();
  function session(id) {
    const key = String(id || 'session').slice(0, 8);
    if (!sessions.has(key)) sessions.set(key, { id: key, project: '', title: '', who: null, terminal: null, synced: false, lastAt: Date.now() });
    const s = sessions.get(key); s.lastAt = Date.now(); return s;
  }
  // Who sits where is the relay's (relay/seats.js): each session it runs comes with its person, by
  // terminal id, and every page and tab draws the same. A session from your own terminal, seen only
  // through its hooks, is not the relay's, so the page gives it the first person the relay has given
  // nobody, the Lead's desk last. If the relay then gives that person to a session of its own, the one
  // from your terminal moves to another person, or leaves the room if nobody is free.
  const relaySeats = new Map();  // terminal id -> person id, from the relay's last list
  try { localStorage.removeItem('office.seats'); } catch (e) { /* what pages kept before the relay seated sessions */ }
  // A desk is a look. The relay gives each of its sessions a name from the roster's pool too
  // (relay/seats.js), and the person at the desk goes by it while that session sits there.
  function callAs(w, name) {
    name = name || w.deskName;
    if (w.name === name) return;
    w.name = name; tagFor[w.id].tag.querySelector('b').textContent = name;
    boardDirty = true; markScreen(w);
  }
  function seat(S) {
    if (S.who && byId[S.who]) return byId[S.who];
    let w = S.terminal ? byId[relaySeats.get(S.terminal)] || null : null;
    const other = w && w.sessionId && w.sessionId !== S.id ? sessions.get(w.sessionId) : null;
    if (other) leaveDesk(other, 'moved desks');
    if (!w) {
      const given = new Set(relaySeats.values());
      const free = people.filter((p) => !p.sessionId && !given.has(p.id));
      w = free.find((p) => !p.lead) || free[0] || null;
    }
    if (!w && S.terminal) {  // sessions you can type into come before ones you can only watch
      const watched = [...sessions.values()].filter((o) => !o.terminal && o.who).sort((a, b) => a.lastAt - b.lastAt)[0];
      if (watched) { w = byId[watched.who]; if (w.waiting) setWaiting(w, null); finish(w, 'made room', 'world'); unseat(watched); }
    }
    if (!w) return null;
    w.sessionId = S.id; S.who = w.id;
    if (!w.present) showPerson(w);
    boardDirty = true; markScreen(w);
    if (other && !other.terminal && !seat(other)) unseat(other);
    return w;
  }
  // A session gives up its person and keeps going, to be seated again.
  function leaveDesk(S, why) {
    const w = S.who && byId[S.who];
    if (w) {
      if (w.waiting) setWaiting(w, null);
      if (w.task) finish(w, why, 'world');
      w.sessionId = null; boardDirty = true; callAs(w, null); markScreen(w); if (w.extra) hidePerson(w);
    }
    S.who = null; S.synced = false;
  }
  function unseat(S) {
    const w = S.who && byId[S.who];
    if (w) { w.sessionId = null; boardDirty = true; callAs(w, null); markScreen(w); if (w.extra && !w.task) hidePerson(w); }
    S.who = null; sessions.delete(S.id);
  }
  // /clear and /resume give a terminal a new session id. Its person stays the same.
  function takeOver(S, terminal) {
    const old = [...sessions.values()].find((o) => o !== S && o.terminal === terminal);
    if (old) {
      const w = old.who && byId[old.who];
      if (w && !S.who) { S.who = w.id; w.sessionId = S.id; old.who = null; }
      if (old.who) unseat(old); else sessions.delete(old.id);
    }
    S.terminal = terminal;
  }
  function workerForSkill(skill) {
    const open = (p) => !p.task && !p.sessionId;
    return people.filter((p) => p.skills.includes(skill)).find(open) || people.find((p) => p.floater && open(p)) || null;
  }
  function toolLine(tool, ti) {
    ti = ti || {};
    const f = ti.file || ti.path || '';
    switch (tool) {
      case 'Edit': case 'MultiEdit': return ['edit ' + (f || 'a file'), 'edit'];
      case 'Write': return ['write ' + (f || 'a file'), 'edit'];
      case 'Read': return ['read ' + (f || 'a file'), 'read'];
      case 'NotebookEdit': return ['edit ' + (f || 'a notebook'), 'edit'];
      case 'Grep': return ['grep ' + (ti.pattern || ''), 'read'];
      case 'Glob': return ['glob ' + (ti.pattern || ''), 'read'];
      case 'Bash': return ['$ ' + (ti.command || '…'), 'bash'];
      case 'WebFetch': return ['fetch ' + (ti.host || ''), 'web'];
      case 'WebSearch': return ['search ' + (ti.query || 'the web'), 'web'];
      case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return ['update the task list', 'tool'];
      default: return [tool.replace(/^mcp__/, '').replace(/__/g, ' ').slice(0, 40), 'tool'];
    }
  }
  function startWork(S, w, src, first) {
    if (w.waiting) setWaiting(w, null);
    if (!w.task) assign(w, { label: S.title || S.project || ('session ' + S.id), session: S.id, first: first || ('session ' + S.id) }, src);
  }
  function relabel(w, label) { w.task.label = label; w.doing = 'Working on ' + label; boardDirty = true; markScreen(w); }
  // A task sent with the work action keeps its own label: only the session's own task takes the title.
  function setTitle(S, title) {
    title = String(title).slice(0, 60);
    if (S.title === title) return;
    S.title = title;
    const w = S.who && byId[S.who];
    if (!w) return;
    if (w.task && w.task.session === S.id) relabel(w, title); else markScreen(w);
  }
  const HOOK_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Notification', 'Stop', 'StopFailure']);
  function onHook(p, src) {
    const ev = p.hook_event_name || p.event || '';
    const S = session(p.session_id);
    if (p.project) S.project = String(p.project).slice(0, 40);
    const handled = (who, extra) => Object.assign({ handled: ev, session: S.id, who: who ? who.id : null }, extra || {});
    if (ev === 'SessionEnd') {
      const w = S.who ? byId[S.who] : null;
      if (w) { if (w.waiting) setWaiting(w, null); finish(w, 'session ended', src); }
      leadLine('session ' + S.id + ' ended', 'done');
      if (!(S.terminal && (p.reason === 'clear' || p.reason === 'resume'))) unseat(S);
      return handled(w);
    }
    if (!HOOK_EVENTS.has(ev)) { if (!S.who) sessions.delete(S.id); return handled(null, { ignored: ev || 'no hook_event_name' }); }
    if (ev === 'SessionStart' && p.terminal && p.source && p.source !== 'startup') takeOver(S, String(p.terminal));
    const w = seat(S);
    // With no desk, a PR it opened still goes out, so Get a review knows the session's PR (office/terminal.js).
    if (!w) { leadLine('no free desk for session ' + S.id, 'fail'); sessions.delete(S.id); return handled(null, Object.assign({ overflow: true }, ev === 'PostToolUse' && p.pr_url ? { prUrl: String(p.pr_url) } : {})); }
    if (p.title && !S.tasked) setTitle(S, p.title);
    const agent = p.agent_id ? String(p.agent_id) : null;
    const ti = p.tool_input || {};
    const mark = agent ? '↳ ' : '';
    switch (ev) {
      case 'SessionStart':
        line(w, 'session ' + S.id + ' started' + (S.project ? ' in ' + S.project : ''), 'start');
        leadLine(w.name + ': session ' + S.id + (S.project ? ' in ' + S.project : ''), 'start');
        return handled(w);
      case 'UserPromptSubmit': {
        const label = S.title || (p.prompt ? '“' + String(p.prompt).slice(0, 28) + '”' : (S.project || 'new prompt'));
        const working = !!w.task;
        startWork(S, w, src, p.prompt ? 'prompt: ' + p.prompt : 'new prompt');
        if (working && p.prompt) line(w, 'prompt: ' + p.prompt, 'start');
        if (w.task.label !== label) relabel(w, label);
        leadLine(w.name + ': new prompt' + (S.project ? ' · ' + S.project : ''), 'prompt');
        return handled(w);
      }
      case 'PreToolUse': {
        if (w.waiting) setWaiting(w, null);
        if (!agent) startWork(S, w, src);
        const tool = p.tool_name || '';
        if (tool === 'Skill') {
          const skill = normSkill(ti.skill || ti.command || ti.name);
          if (!skill) return handled(w, { ignored: 'no skill name' });
          line(w, mark + 'skill /' + skill + (ti.args ? ' ' + ti.args : ''), 'skill');
          if (!agent) { if (!S.title) relabel(w, '/' + skill); w.task.skill = skill; bubble(w, '/' + skill, 2); }
          leadLine(w.name + ': /' + skill, 'skill');
          return handled(w, { skill });
        }
        if (tool === 'Agent' || tool === 'Task') {
          const type = ti.subagent_type || 'general-purpose';
          line(w, mark + 'agent ' + type + (ti.description ? ': ' + ti.description : ''), 'agent');
          leadLine(w.name + ': agent ' + type, 'agent');
          return handled(w, { agentType: type });
        }
        const [text, kind] = toolLine(tool, ti);
        line(w, mark + text, kind);
        if (w !== lead) leadLine(w.name + ': ' + text, kind);
        return handled(w, { tool });
      }
      case 'PostToolUse':
        if (w.waiting) setWaiting(w, null);  // you answered, and the tool ran
        if (p.pr_url) { line(w, 'opened ' + String(p.pr_url).replace('https://github.com/', ''), 'web'); leadLine(w.name + ': opened a PR', 'web'); }
        return handled(w, Object.assign(p.pr_url ? { prUrl: String(p.pr_url) } : {}, p.pushed ? { pushed: true } : {}));
      case 'PostToolUseFailure':
        line(w, mark + '✕ ' + (p.tool_name || 'tool') + ' failed', 'fail');
        return handled(w);
      case 'SubagentStart':
        line(w, '↳ ' + (p.agent_type || 'subagent') + ' started', 'agent');
        return handled(w);
      case 'SubagentStop':
        line(w, '↳ ' + (p.agent_type || 'subagent') + ' finished', 'agent');
        return handled(w);
      case 'Notification': {
        const msg = p.message || 'Waiting for you';
        if (/waiting for your input|idle/i.test(msg + ' ' + (p.notification_type || ''))) { leadLine(w.name + ': waiting for a prompt', 'wait'); return handled(w, { idle: true }); }
        startWork(S, w, src);
        setWaiting(w, msg); leadLine(w.name + ': ? ' + msg, 'wait');
        return handled(w, { waiting: true });
      }
      default:  // Stop, StopFailure
        if (w.waiting) setWaiting(w, null);
        finish(w, ev === 'StopFailure' ? 'stopped' : 'done', src);
        leadLine(w.name + ': turn finished', 'done');
        return handled(w);
    }
  }
  // The relay's list of the sessions it runs, each with its person. The panel sends it every few
  // seconds, so a page that was just opened or reloaded seats them, in the state the relay last heard.
  function syncSessions(list, src) {
    const live = new Set(), mine = [];
    relaySeats.clear();
    for (const t of list) if (t && t.id && t.seat && byId[t.seat]) relaySeats.set(String(t.id), String(t.seat));
    for (const t of list) {
      if (!t || !t.id || !t.sessionId) continue;
      live.add(String(t.id));
      const S = session(t.sessionId);
      takeOver(S, String(t.id));
      if (t.project && !S.project) S.project = String(t.project).slice(0, 40);
      S.lead = !!t.lead;
      S.customTitle = t.customTitle ? String(t.customTitle) : null;
      mine.push([S, t]);
    }
    // Sessions the relay no longer runs leave first, so their people are free.
    for (const S of [...sessions.values()]) {
      if (!S.terminal || live.has(S.terminal)) continue;
      const w = S.who ? byId[S.who] : null;
      if (w) { if (w.waiting) setWaiting(w, null); finish(w, 'session ended', src); }
      unseat(S);
    }
    // Anyone the relay moved, such as to or off the Lead's desk, leaves the person they had, so nobody is
    // drawn twice.
    for (const [S, t] of mine) { const want = relaySeats.get(String(t.id)); if (S.who && want && S.who !== want) leaveDesk(S, 'moved desks'); }
    for (const [S, t] of mine) {
      const w = seat(S);
      if (!w) { sessions.delete(S.id); continue; }
      callAs(w, t.who ? String(t.who).slice(0, 40) : null);
      // a task's title is the label for as long as the task lasts; Claude's own title does not replace it
      window.OfficeSeats.noteWork(S, t, setTitle);
      if (!S.synced) {
        S.synced = true;
        if (t.state === 'working' || t.state === 'waiting') { startWork(S, w, src); placeAtDesk(w); }
        if (t.state === 'waiting') setWaiting(w, t.message || 'Needs your OK');
      }
    }
  }

  // ---------- actions ----------
  function findWorker(c) {
    if (c.who) return byId[String(c.who).toLowerCase()] || people.find((p) => p.name.toLowerCase() === String(c.who).toLowerCase()) || null;
    if (c.skill) { const s = normSkill(c.skill); return people.find((p) => p.task && p.task.skill === s) || workerForSkill(s); }
    return null;
  }
  const IDLE_SPOTS = { coffee: 'espresso', couch: 'couch', window: 'win', chat: 'bar', board: 'board', desk: 'desk', fridge: 'fridge', pingpong: 'pp' };
  const fail = (error, message) => ({ ok: false, error, message });
  const ACTIONS = {
    ready: { desc: 'Waits until the room is built. Answers at once if it is.', params: {}, run: () => ({ ok: true, people: people.length }) },
    state: { desc: 'A JSON snapshot of the room.', params: {}, run: () => ({ ok: true, state: snapshot() }) },
    roster: { desc: 'Who works here and which skills send them to work.', params: {}, run: () => ({ ok: true, people: people.map((p) => ({ id: p.id, name: p.name, role: p.role, skills: p.skills, floater: p.floater, lead: p.lead })) }) },
    hook: { desc: 'A Claude Code hook event, as sent by relay/office-hook.js.', params: { event: 'the hook payload' },
      run: (c, src) => { const p = c.event || c.payload; if (!p || typeof p !== 'object') return fail('bad_param', 'Send the hook payload as "event".'); const r = onHook(p, src); emit('hook', { event: p.hook_event_name || '', tool: p.tool_name || null, who: r.who, session: r.session, ...(r.prUrl ? { prUrl: r.prUrl, cwd: p.cwd || null } : {}), ...(r.pushed ? { pushed: true } : {}) }, src); return Object.assign({ ok: true }, r); } },
    sessions: { desc: 'The sessions the relay runs, so each has a person. The Claude Code panel sends this.', params: { list: 'the relay\'s terminals' },
      run: (c, src) => { if (!Array.isArray(c.list)) return fail('bad_param', 'Send "list".'); syncSessions(c.list, src); return { ok: true, sessions: sessions.size }; } },
    tasks: { desc: 'The tasks on the board. The Tasks panel sends this.', params: { list: 'id, title, state and who for each task' },
      run: (c) => { if (!Array.isArray(c.list)) return fail('bad_param', 'Send "list".'); const next = JSON.stringify(c.list); if (next !== JSON.stringify(taskList)) { taskList = c.list; boardDirty = true; } return { ok: true, tasks: taskList.length }; } },
    work: { desc: 'Sends someone to their desk to work.', params: { who: 'a person id or name', skill: 'or a skill, which picks the person', label: 'optional: what the sticky note says', session: 'optional' },
      run: (c, src) => {
        const s = c.skill ? normSkill(c.skill) : null;
        const w = c.who ? findWorker(c) : s ? workerForSkill(s) : null;
        if (!w) return c.who || s ? fail('busy', 'Nobody free can take that work.') : fail('bad_param', 'Name "who" or "skill".');
        assign(w, { skill: s, label: c.label || (s ? '/' + s : 'work'), session: c.session || null }, src);
        return { ok: true, who: w.id, label: w.task.label };
      } },
    activity: { desc: 'Puts a line on the monitor of the person working on that skill, or of "who".', params: { who: 'or skill', text: 'the line', kind: 'optional: edit, read, bash, web, tool, fail' },
      run: (c) => { const w = findWorker(c) || lead; if (!c.text) return fail('bad_param', 'Send "text".'); line(w, c.text, c.kind); if (w !== lead) leadLine(w.name + ': ' + c.text, c.kind); return { ok: true, who: w.id }; } },
    done: { desc: 'Finishes work: one person, the person on a skill, or everyone with "all".', params: { who: 'or skill', all: 'true for everyone' },
      run: (c, src) => {
        if (c.all) { const ids = people.filter((p) => p.task).map((p) => p.id); ids.forEach((id) => finish(byId[id], 'done', src)); return { ok: true, finished: ids }; }
        const w = c.skill ? people.find((p) => p.task && p.task.skill === normSkill(c.skill)) : findWorker(c);
        if (!w) return fail('bad_param', 'Nobody by that name or skill.');
        if (!w.task) return fail('not_now', w.name + ' is not working.');
        finish(w, 'done', src); return { ok: true, finished: [w.id] };
      } },
    waiting: { desc: 'The lead raises a hand because the agent needs you. Send no message to clear it.', params: { message: 'optional' },
      run: (c) => { setWaiting(lead, c.message === undefined ? 'Needs your OK' : c.message || null); return { ok: true, waiting: !!lead.waiting }; } },
    idle: { desc: 'Sends someone who is not working to do something: coffee, couch, window, chat, board, desk, fridge or pingpong.', params: { who: 'a person', do: Object.keys(IDLE_SPOTS).join(', ') },
      run: (c) => {
        const w = findWorker(c); if (!w) return fail('bad_param', 'Name "who".');
        if (w.task) return fail('busy', w.name + ' is working.');
        if (w.waiting) return fail('busy', w.name + ' is waiting for your OK.');
        const what = c.do || 'coffee';
        if (!IDLE_SPOTS[what]) return fail('bad_param', '"do" is one of: ' + Object.keys(IDLE_SPOTS).join(', ') + '.');
        if (what === 'coffee') { if (!free('espresso')) return fail('busy', 'Someone is at the machine.'); coffeeRun(w); }
        else if (what === 'desk') goTo(w, w.desk, act({ dur: rand(20, 40), pose: 'leanback', label: 'At their desk' }), 'Going to their desk');
        else if (what === 'pingpong') { const partner = people.find((p) => p !== w && !p.lead && !p.task && !p.pingpong); if (!partner || !free('pp-w') || !free('pp-e')) return fail('busy', 'Nobody to play with, or the table is taken.'); startPingPong(w, partner); }
        else {
          const keys = Object.keys(SPOTS).filter((k) => k.startsWith(IDLE_SPOTS[what]) && free(k)); if (!keys.length) return fail('busy', 'No free spot for that.');
          const k = pick(keys), pose = what === 'couch' ? 'couch' : what === 'fridge' ? 'fridge' : what === 'window' ? 'pockets' : 'stand';
          goTo(w, k, act({ dur: what === 'fridge' ? 4 : rand(15, 30), pose, prop: what === 'couch' ? 'phone' : null, chat: what === 'chat', board: what === 'board', fridge: what === 'fridge', label: SPOTS[k].label || ({ couch: 'On the couch', chat: 'Chatting' })[what] }), 'Going over');
        }
        w.step = null; return { ok: true, who: w.id, doing: what };
      } },
    huddle: { desc: 'For a moment, people with no real work gather at the bar table and the board. Anyone with real work stays at their desk. Nobody moves under reduced motion, or while the manager is in.', params: {},
      run: () => {
        if (reduce || boss.present) return { ok: true, gathered: [] };
        const gathered = gather(['bar-w', 'bar-e', 'bar-s', 'board-0', 'board-1'], (k) => act({ dur: rand(10, 16), pose: 'stand', chat: k.startsWith('bar'), board: k.startsWith('board'), label: 'At the huddle' }), 'Going to the huddle');
        return { ok: true, gathered };
      } },
    party: { desc: 'Throws a party for about a minute, or ends the one going on. Everyone wears a party hat, a cake with candles stands on the coffee table, and people with no real work gather round it. Anyone with real work stays at their desk, and no session is touched. Nobody moves under reduced motion, or while the manager is in.', params: { on: 'optional: true starts one, false ends it; left out, it toggles', seconds: 'optional: how long it lasts, 5 to 600, 60 if left out' },
      run: (c, src) => {
        const on = c.on === undefined ? undefined : c.on === true || c.on === 'true' ? true : c.on === false || c.on === 'false' ? false : null;
        if (on === null) return fail('bad_param', '"on" is true or false, or left out to toggle.');
        const want = on === undefined ? !party.on || party.ending : on;
        const secs = c.seconds === undefined ? PARTY_SECONDS : Number(c.seconds);
        if (!(secs >= 5 && secs <= 600)) return fail('bad_param', '"seconds" is 5 to 600.');
        if (want) { if (party.on && !party.ending) return fail('busy', 'A party is going on already.'); startParty(src, secs); }
        else if (party.on && !party.ending) endParty(src);
        return { ok: true, party: partyState() };
      } },
    say: { desc: 'Shows a speech bubble.', params: { who: 'a person', text: 'what they say' }, run: (c) => { const w = findWorker(c) || lead; bubble(w, String(c.text || '').slice(0, 60), 3); return { ok: true, who: w.id }; } },
    manager: { desc: 'Sends the manager through now, instead of waiting for the next visit.', params: {}, run: (c, src) => { if (boss.present) return fail('busy', 'The manager is already here.'); bossVisit(src); return { ok: true }; } },
    reset: { desc: 'Ends all work and clears the board.', params: {}, run: (c, src) => { people.forEach((p) => { finish(p, 'reset', src); if (p.waiting) setWaiting(p, null); }); done.length = 0; [...sessions.values()].forEach(unseat); boardDirty = true; return { ok: true }; } },
    speed: { desc: 'How fast the room moves: 0 to 8, 1 is normal. Work state does not depend on it.', params: { value: '0 to 8' }, run: (c) => { const v = Number(c.value); if (!(v >= 0 && v <= 8)) return fail('bad_param', '"value" is 0 to 8.'); speed = v; return { ok: true, speed }; } },
    wait: { desc: 'Waits this many seconds of real time.', params: { seconds: '0 to 600' }, run: (c) => { const s = Number(c.seconds); if (!(s >= 0 && s <= 600)) return Promise.resolve(fail('bad_param', '"seconds" is 0 to 600.')); return new Promise((r) => setTimeout(() => r({ ok: true, waited: s }), s * 1000)); } }
  };
  async function doAction(cmd) {
    const c = Object.assign({}, cmd || {}), src = c.source || 'api', name = c.action;
    const A = ACTIONS[name];
    const params = Object.assign({}, c); delete params.action; delete params.source;
    const quiet = name === 'hook' || name === 'sessions' || name === 'tasks';
    if (!quiet) emit('action', { action: name, params }, src);
    let result;
    if (!A) result = fail('unknown_action', 'Unknown action "' + name + '". Actions: ' + Object.keys(ACTIONS).join(', ') + '.');
    else { try { result = await A.run(c, src); } catch (err) { console.error(err); result = fail('error', String((err && err.message) || err)); } }
    if (!quiet || !result.ok) emit('result', { action: name, ok: !!result.ok, result }, src);
    return result;
  }

  function snapshot() {
    return {
      world: 'office', company: ROSTER.company, clock: clockText(), time: part, speed, holiday: decorState(),
      busy: people.filter((p) => p.task).length, people: people.filter((p) => p.present).length, managerHere: boss.present, party: partyState(),
      waitingOnYou: people.filter((p) => p.waiting).map((p) => ({ who: p.id, name: p.name, message: p.waiting.message })),
      workers: people.map((w) => ({
        id: w.id, name: w.name, role: w.role, color: w.color, lead: w.lead, floater: w.floater, skills: w.skills, present: w.present,
        session: w.sessionId && sessions.get(w.sessionId) ? (({ id, project, title, customTitle, terminal, work }) => ({ id, project, title, customTitle: customTitle || null, terminal, work: work || null }))(sessions.get(w.sessionId)) : null,
        status: w.waiting ? 'waiting' : w.task ? 'working' : 'idle', doing: w.waiting ? 'Needs your OK: ' + w.waiting.message : w.doing,
        task: w.task ? { label: w.task.label, skill: w.task.skill || null, session: w.task.session || null, seconds: Math.round((Date.now() - w.task.startedAt) / 1000), last: (w.task.lines[w.task.lines.length - 1] || {}).text || '' } : null,
        recent: w.history.slice(0, 5)
      })),
      done: done.slice(0, 12),
      sessions: [...sessions.values()].map((s) => ({ id: s.id, project: s.project, title: s.title, who: s.who, terminal: s.terminal }))
    };
  }

  // ---------- clicking a person ----------
  // The panels listen for this: the floor board selects them and the terminal shows their session.
  function pickWorker(w) { window.dispatchEvent(new CustomEvent('office:pick', { detail: { who: w.id } })); }
  if (renderer) {
    const ray = new THREE.Raycaster(), at = new THREE.Vector2();
    let down = null;
    canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    canvas.addEventListener('click', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;  // a drag moved the camera
      const r = canvas.getBoundingClientRect();
      at.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(at, camera);
      const hit = ray.intersectObjects(people.filter((p) => p.present).map((p) => p.fig.root), true)[0];
      for (let o = hit && hit.object; o; o = o.parent) { const w = people.find((p) => p.fig.root === o); if (w) { pickWorker(w); return; } }
    });
  }

  // ---------- holiday decorations ----------
  // office/holidays.js picks the holiday from this browser's date. Only that holiday's decorations
  // are built, and they come down when it ends. They go only where nothing they could cover stands
  // between them and the camera: high on the back and window walls (never on the board, the neon or the
  // clock), the window sills, the coffee counter, two floor corners by the back wall that nobody walks
  // through, and flat on the desk tops between the seats. The switch is kept in this browser; a
  // preview is not.
  const HOL = window.OfficeHolidays;
  const DECOR_KEY = 'office.decorations';
  let decorOn = true, decorPreview = '';
  try { decorOn = localStorage.getItem(DECOR_KEY) !== 'off'; } catch (e) { /* no storage */ }
  if (HOL && HOL.KEYS.includes(params.get('holiday'))) decorPreview = params.get('holiday');
  if (params.get('holiday') === 'off') decorOn = false;  // for this page only, not kept
  const decor = { group: null, key: null, year: null, anims: [], cells: [], confetti: null, confettiUntil: 0, checkedAt: 0 };
  // Each wall run: two ends of a line that dips by sag in the middle, and the way the wall faces.
  const DECOR_RUNS = [
    { a: [-6.9, 3.5, -4.93], b: [-2.65, 3.5, -4.93], sag: 0.18, yaw: 0 },
    { a: [0.6, 3.5, -4.93], b: [6.95, 3.5, -4.93], sag: 0.22, yaw: 0 },
    { a: [-6.95, 4.42, -4.9], b: [-6.95, 4.42, 4.9], sag: 0.3, yaw: Math.PI / 2 }
  ];
  const SILLS = [[-6.92, 0.905, -3.0], [-6.92, 0.905, 0.0], [-6.92, 0.905, 3.0]];
  const COUNTER = [[5.0, 0.93, -4.5], [5.55, 0.93, -4.52], [6.05, 0.93, -4.5]];
  const CORNER = { bike: [-5.55, -4.45], board: [-3.5, -4.5] };
  const FACE = Math.atan2(HOME.x, HOME.z);  // things with a front turn it to the camera's usual place
  const glow = (hex) => new THREE.MeshBasicMaterial({ color: C(hex), toneMapped: false });
  const along = (run, k) => { const [a, b] = [run.a, run.b]; return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k - run.sag * 4 * k * (1 - k), a[2] + (b[2] - a[2]) * k]; };
  const runLength = (run) => Math.hypot(run.b[0] - run.a[0], run.b[2] - run.a[2]);
  const dummy = new THREE.Object3D();
  // One draw call for many copies of a shape: each entry of at is [position, rotation, scale].
  function many(parent, geo, mat, at) {
    const m = new THREE.InstancedMesh(geo, mat, Math.max(1, at.length)); m.count = at.length;
    at.forEach(([p, r, s], i) => { dummy.position.set(p[0], p[1], p[2]); dummy.rotation.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0); dummy.scale.setScalar(s || 1); dummy.updateMatrix(); m.setMatrixAt(i, dummy.matrix); });
    m.instanceMatrix.needsUpdate = true; m.frustumCulled = false; parent.add(m); return m;
  }
  // A wire along each wall run, and a thing every gap metres along it, by colour.
  function wallLine(g, color, r, runs) {
    const mat = std(color, { roughness: 0.6 });
    for (const run of runs || DECOR_RUNS) { const pts = []; for (let i = 0; i <= 24; i++) pts.push(new THREE.Vector3(...along(run, i / 24))); mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, r || 0.008, 5), mat, g); }
  }
  function alongWalls(gap, colors, fn, runs) {
    const by = colors.map(() => []); let n = 0;
    for (const run of runs || DECOR_RUNS) {
      const count = Math.floor(runLength(run) / gap);
      for (let i = 1; i < count; i++) { const p = along(run, i / count); if (!run.yaw && p[0] > 1.45 && p[0] < 2.65) continue; by[n % colors.length].push(fn(p, run, n)); n++; }  // nothing hangs over the clock
    }
    return by;
  }
  // Nobody walks into a decoration on the floor while it is up: not the people, and not the manager,
  // who walks on a grid of their own.
  function blockFloor(x, z, r) {
    for (let j = cellZ(z - r - BODY); j <= cellZ(z + r + BODY); j++) for (let i = cellX(x - r - BODY); i <= cellX(x + r + BODY); i++) {
      if ((cx(i) - x) ** 2 + (cz(j) - z) ** 2 > (r + BODY) ** 2) continue;
      for (const grid of [blocked, bossGrid]) if (!grid[j * GX + i]) { grid[j * GX + i] = 1; decor.cells.push([grid, j * GX + i]); }
    }
  }
  // Someone already walking plans the rest of the way again on the grid as it is now.
  function replanWalks() {
    for (const w of people.concat(boss)) if (w.step && w.step.t === 'walk' && w.step.path && SPOTS[w.step.key]) w.step.path = findPath(w.pos, SPOTS[w.step.key].approach, w.grid);
  }
  function groupAt(parent, p, yaw, s) { const g = new THREE.Group(); g.position.set(p[0], p[1], p[2]); g.rotation.y = yaw || 0; if (s) g.scale.setScalar(s); parent.add(g); return g; }

  // pieces several holidays share
  const faceC = makeCanvas(128, 128); (function () {
    const x = faceC.getContext('2d'); x.lineJoin = 'round';
    const shapes = [
      () => { x.moveTo(20, 58); x.lineTo(46, 22); x.lineTo(56, 62); },
      () => { x.moveTo(108, 58); x.lineTo(82, 22); x.lineTo(72, 62); },
      () => { x.moveTo(56, 70); x.lineTo(72, 70); x.lineTo(64, 84); },
      () => { x.moveTo(16, 84); x.quadraticCurveTo(64, 132, 112, 84); x.lineTo(96, 90); x.lineTo(88, 102); x.lineTo(78, 94); x.lineTo(64, 106); x.lineTo(50, 94); x.lineTo(40, 102); x.lineTo(32, 90); }
    ];
    for (const [stroke, fill, w] of [['#3b1a06', '#3b1a06', 10], [null, '#ffc23a', 0]]) for (const s of shapes) {  // a dark cut edge, and the candle's light inside
      x.beginPath(); s(); x.closePath(); x.fillStyle = fill; x.fill(); if (stroke) { x.strokeStyle = stroke; x.lineWidth = w; x.stroke(); }
    }
  })();
  let faceMat = null;
  function pumpkin(parent, p, r, carved, yaw) {
    const g = groupAt(parent, [p[0], p[1] + r * 0.78, p[2]], yaw == null ? FACE : yaw);
    const skin = std(carved ? 0xe0761f : pick([0xe0761f, 0xd9822b, 0xc9672a, 0xe8b04a]), { roughness: 0.55 });
    for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI; ball(g, skin, [0, 0, 0], r, [1, 0.8, 0.68]).rotation.y = a; }
    rod(g, std(0x4f5d2a), [0, r * 0.7, 0], [r * 0.12, r * 1.05, 0], r * 0.09);
    if (carved) {
      if (!faceMat) faceMat = new THREE.MeshBasicMaterial({ map: tex(faceC), transparent: true, depthWrite: false, toneMapped: false });
      const f = mesh(new THREE.PlaneGeometry(r * 1.3, r * 1.3), faceMat, g, false); f.position.set(0, -r * 0.05, r * 1.01);
    }
    return g;
  }
  function eggs(parent, p, n, spread, seed) {
    const r = rnd(seed), at = [];
    for (let i = 0; i < n; i++) at.push([[p[0] + (r() - 0.5) * spread, p[1] + 0.06, p[2] + (r() - 0.5) * spread], [r() * 0.5, r() * 6, r() * 0.5 - 0.25], 1]);
    const colors = [0xf4b6c8, 0xbfe3c0, 0xbcd7f2, 0xf7e3a1, 0xd6c3ef, 0xfbd0a8];
    if (!decor.egg) { decor.egg = new THREE.SphereGeometry(0.055, 14, 10); decor.egg.scale(1, 1.3, 1); }
    colors.forEach((c, k) => { const mine = at.filter((_, i) => i % colors.length === k); if (mine.length) many(parent, decor.egg, std(c, { roughness: 0.45 }), mine); });
  }
  function present(parent, p, size, color, ribbon) {
    const g = groupAt(parent, [p[0], 0, p[1]], rand(-0.4, 0.4)), w = size[0], h = size[1], d = size[2];
    block(g, std(color, { roughness: 0.5 }), [0, h / 2, 0], [w, h, d]);
    const rib = std(ribbon, { roughness: 0.35, metalness: 0.3 });
    block(g, rib, [0, h / 2, 0], [w + 0.006, h + 0.006, Math.min(0.05, d * 0.18)]); block(g, rib, [0, h / 2, 0], [Math.min(0.05, w * 0.18), h + 0.006, d + 0.006]);
    ball(g, rib, [-0.03, h + 0.02, 0], 0.04, [1, 0.6, 0.6]).rotation.z = 0.5; ball(g, rib, [0.03, h + 0.02, 0], 0.04, [1, 0.6, 0.6]).rotation.z = -0.5;
  }
  function flag(parent, p, h) {  // a little flag on a stick
    const g = groupAt(parent, p, FACE + 0.5);
    rod(g, std(0xd8c8a0), [0, 0, 0], [0, h, 0], 0.004);
    if (!decor.flagMat) decor.flagMat = flagMaterial();
    const f = mesh(new THREE.PlaneGeometry(0.15, 0.09), decor.flagMat, g, false); f.position.set(0.078, h - 0.05, 0);
  }

  const BUILD = {
    newyear(g, year) {
      // a banner above the windows, and streamers along the walls
      const c = makeCanvas(1024, 160), x = c.getContext('2d');
      x.fillStyle = '#16203a'; x.fillRect(0, 0, 1024, 160); x.strokeStyle = '#e8c45a'; x.lineWidth = 8; x.strokeRect(8, 8, 1008, 144);
      x.font = '700 92px "Source Sans 3", "Source Sans Pro", system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillStyle = '#ffe08a'; x.shadowColor = '#ffb84d'; x.shadowBlur = 18; x.fillText('Happy New Year ' + year, 512, 84);
      const banner = mesh(new THREE.PlaneGeometry(4.2, 0.62), new THREE.MeshBasicMaterial({ map: tex(c), toneMapped: false }), g, false);
      banner.position.set(-6.97, 4.25, -1.3); banner.rotation.y = Math.PI / 2;
      const L = DECOR_RUNS[2], runs = [DECOR_RUNS[0], DECOR_RUNS[1], { a: L.a, b: [L.a[0], L.a[1], -3.55], sag: 0.1, yaw: L.yaw }, { a: [L.a[0], L.a[1], 0.95], b: L.b, sag: 0.2, yaw: L.yaw }];
      wallLine(g, 0xe8c45a, 0.01, runs);
      const strip = new THREE.PlaneGeometry(0.06, 0.7); strip.translate(0, -0.35, 0);
      const colors = [0xe8c45a, 0xc0c6cf, 0xd2407a, 0x2bb3a8, 0x6a5acd];
      alongWalls(0.22, colors, (p, run, n) => [[p[0] + (run.yaw ? 0.02 : 0), p[1], p[2] + (run.yaw ? 0 : 0.02)], [Math.sin(n) * 0.15, run.yaw + Math.cos(n * 1.7) * 0.6, Math.sin(n * 2.3) * 0.12], 0.7 + (n % 3) * 0.2], runs)
        .forEach((at, k) => many(g, strip, std(colors[k], { roughness: 0.3, metalness: 0.4, side: THREE.DoubleSide }), at));
      // confetti, kept ready for midnight
      const n = 300, m = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.05, 0.03), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }), n);
      const bits = [];
      for (let i = 0; i < n; i++) { m.setColorAt(i, C(pick(colors.concat([0xffffff])))); bits.push({ p: new THREE.Vector3(), v: 0, lie: 0, spin: new THREE.Vector3(rand(-4, 4), rand(-4, 4), rand(-4, 4)), r: new THREE.Euler(), live: false }); }
      m.visible = false; m.frustumCulled = false; g.add(m);
      decor.confetti = { m, bits };
    },
    easter(g) {
      SILLS.forEach((p, i) => eggs(g, p, 3, 0.14, 11 + i));
      // a basket of eggs by the board, more eggs on the counter, and two bunnies
      const basket = groupAt(g, [CORNER.board[0], 0, CORNER.board[1]], 0.3);
      cyl(basket, std(0xb9874f, { roughness: 0.9 }), [0, 0.11, 0], 0.22, 0.22, 0.25);
      const handle = mesh(new THREE.TorusGeometry(0.22, 0.015, 6, 20, Math.PI), std(0xb9874f, { roughness: 0.9 }), basket); handle.position.y = 0.22;
      eggs(g, [CORNER.board[0], 0.17, CORNER.board[1]], 7, 0.26, 3);
      eggs(g, [CORNER.board[0] + 0.45, 0, CORNER.board[1] + 0.1], 3, 0.25, 4);
      eggs(g, COUNTER[0], 4, 0.25, 5);
      bunny(g, [CORNER.bike[0], 0, CORNER.bike[1]], 1);
      bunny(g, COUNTER[2], 0.45);
      eggs(g, [CORNER.bike[0] + 0.35, 0, CORNER.bike[1] + 0.15], 4, 0.3, 6);
      blockFloor(CORNER.board[0], CORNER.board[1], 0.45); blockFloor(CORNER.bike[0], CORNER.bike[1], 0.45);
    },
    july4(g) {
      wallLine(g, 0x2a2a2a);
      const tri = new THREE.BufferGeometry(); tri.setAttribute('position', new THREE.Float32BufferAttribute([-0.13, 0, 0, 0.13, 0, 0, 0, -0.32, 0], 3)); tri.computeVertexNormals();
      const colors = [0xc8102e, 0xf4f4f4, 0x1f3a93];
      alongWalls(0.3, colors, (p, run) => [[p[0] + (run.yaw ? 0.01 : 0), p[1], p[2] + (run.yaw ? 0 : 0.01)], [0, run.yaw, 0], 1])
        .forEach((at, k) => many(g, tri, std(colors[k], { roughness: 0.7, side: THREE.DoubleSide }), at));
      SILLS.forEach((p) => { flag(g, [p[0], p[1], p[2] - 0.05], 0.28); flag(g, [p[0], p[1], p[2] + 0.07], 0.24); });
      const cup = groupAt(g, COUNTER[1], 0); cyl(cup, std(0x1f3a93), [0, 0.06, 0], 0.05, 0.12, 0.06);
      [-0.03, 0, 0.03].forEach((dx, i) => flag(g, [COUNTER[1][0] + dx, COUNTER[1][1] + 0.02, COUNTER[1][2]], 0.34 + i * 0.03));
      // a star-spangled pail of flags at the bike corner
      const pail = groupAt(g, [CORNER.bike[0], 0, CORNER.bike[1]], 0); cyl(pail, std(0xc8102e), [0, 0.13, 0], 0.13, 0.26, 0.16);
      for (let i = 0; i < 5; i++) flag(g, [CORNER.bike[0] + (i - 2) * 0.04, 0.2, CORNER.bike[1] + (i % 2) * 0.03], 0.55 + (i % 3) * 0.06);
      blockFloor(CORNER.bike[0], CORNER.bike[1], 0.25);
    },
    halloween(g) {
      // jack-o'-lanterns that glow, cobwebs in the corners and two bats
      SILLS.forEach((p) => pumpkin(g, p, 0.1, true, 1.2));  // facing the room
      pumpkin(g, COUNTER[1], 0.15, true);
      pumpkin(g, [CORNER.board[0], 0, CORNER.board[1]], 0.25, true); pumpkin(g, [CORNER.board[0] + 0.42, 0, CORNER.board[1] + 0.12], 0.16, true);
      pumpkin(g, [CORNER.bike[0], 0, CORNER.bike[1]], 0.24, true); pumpkin(g, [CORNER.bike[0] + 0.42, 0, CORNER.bike[1] + 0.1], 0.15, false);
      blockFloor(CORNER.board[0] + 0.15, CORNER.board[1], 0.4); blockFloor(CORNER.bike[0] + 0.15, CORNER.bike[1], 0.35);
      const web = makeCanvas(256, 256), x = web.getContext('2d');
      x.strokeStyle = 'rgba(235,235,240,0.75)'; x.lineWidth = 1.6;
      for (let i = 0; i <= 8; i++) { const a = (i / 8) * Math.PI / 2; x.beginPath(); x.moveTo(0, 0); x.lineTo(Math.cos(a) * 256, Math.sin(a) * 256); x.stroke(); }
      for (let k = 1; k <= 6; k++) { x.beginPath(); for (let i = 0; i <= 8; i++) { const a = (i / 8) * Math.PI / 2, rr = k * 40 - (i % 2) * 6; if (i) x.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); else x.moveTo(rr, 0); } x.stroke(); }
      const webMat = new THREE.MeshBasicMaterial({ map: tex(web), transparent: true, depthWrite: false, side: THREE.DoubleSide });
      const webAt = (p, rot, s) => { const m = mesh(new THREE.PlaneGeometry(s, s), webMat, g, false); m.geometry.translate(s / 2, -s / 2, 0); m.position.set(p[0], p[1], p[2]); m.rotation.set(rot[0], rot[1], rot[2]); };
      webAt([-4.32, 4.06, -3.15], [0, 0, 0], 0.62);  // where a column meets the duct
      webAt([3.18, 4.06, -3.15], [0, 0, 0], 0.62);
      webAt([-6.98, 3.55, -4.3], [0, Math.PI / 4, 0], 0.75);  // the corner by the windows
      webAt([-6.98, 3.9, 4.0], [0, Math.PI / 2, 0], 0.5);  // over the last window
      const batMat = std(0x16131a, { roughness: 0.8 }), wingGeo = new THREE.BufferGeometry();
      wingGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.22, 0.05, 0, 0.17, -0.02, 0, 0, 0, 0, 0.17, -0.02, 0, 0.1, -0.05, 0, 0, 0, 0, 0.1, -0.05, 0, 0.03, -0.06, 0], 3)); wingGeo.computeVertexNormals();
      [[-5.8, 3.1, -4.45, 0], [5.2, 2.9, -4.5, 2]].forEach(([bx, by, bz, phase]) => {
        const bat = groupAt(g, [bx, by, bz], 0, 1.8);
        ball(bat, batMat, [0, 0, 0], 0.045, [0.8, 1, 0.8]); ball(bat, batMat, [0, 0.055, 0], 0.03);
        for (const s of [-1, 1]) block(bat, batMat, [s * 0.016, 0.085, 0], [0.012, 0.03, 0.01], [0, 0, s * 0.3]);
        const wings = [-1, 1].map((s) => { const w = new THREE.Group(); w.scale.x = s; bat.add(w); mesh(wingGeo, std(0x16131a, { roughness: 0.8, side: THREE.DoubleSide }), w, false); return w; });
        decor.anims.push((t) => {
          const k = t * 0.6 + phase;
          bat.position.set(bx + Math.sin(k) * 0.6, by + Math.sin(k * 2) * 0.12, bz); bat.rotation.z = Math.cos(k) * 0.25;
          const flap = Math.sin(t * 14 + phase) * 0.7; wings[0].rotation.y = flap; wings[1].rotation.y = -flap;
        });
      });
      decor.anims.push((t) => { if (faceMat) faceMat.color.setScalar(0.82 + Math.sin(t * 9) * 0.06 + Math.sin(t * 23) * 0.06); });
    },
    thanksgiving(g) {
      // a cornucopia on the counter, pumpkins, and autumn leaves on the desks
      const horn = groupAt(g, COUNTER[1], FACE - Math.PI / 2 + 0.4), wicker = std(0xb8874a, { roughness: 0.9 });
      const pts = []; for (let i = 0; i <= 12; i++) { const k = i / 12; pts.push([-0.28 + k * 0.5, 0.11 - k * 0.02 + Math.sin(k * Math.PI * 1.2) * 0.04 + (k > 0.8 ? (k - 0.8) * 0.5 : 0), -Math.sin(k * 2.4) * 0.04]); }
      for (let i = 0; i < 12; i++) { const r = 0.1 * (1 - i / 12) + 0.008; rod(horn, wicker, pts[i], pts[i + 1], r); }
      [[-0.32, 0.1, 0.02, 0x8e1f1f, 0.05], [-0.34, 0.06, -0.06, 0xe3922a, 0.048], [-0.36, 0.14, -0.02, 0xd9b44a, 0.04], [-0.38, 0.04, 0.06, 0x7a9a3a, 0.04]].forEach(([fx, fy, fz, col, r]) => ball(horn, std(col, { roughness: 0.4 }), [fx, fy, fz], r));
      for (let i = 0; i < 6; i++) ball(horn, std(0x5b2a6e, { roughness: 0.35 }), [-0.38 + (i % 3) * 0.022, 0.12 - Math.floor(i / 3) * 0.03, 0.05], 0.018);
      SILLS.forEach((p, i) => pumpkin(g, [p[0], p[1], p[2] + (i - 1) * 0.04], 0.09, false));
      pumpkin(g, [CORNER.board[0], 0, CORNER.board[1]], 0.25, false); pumpkin(g, [CORNER.board[0] + 0.42, 0, CORNER.board[1] + 0.1], 0.15, false);
      pumpkin(g, [CORNER.bike[0], 0, CORNER.bike[1]], 0.22, false); pumpkin(g, [CORNER.bike[0] + 0.4, 0, CORNER.bike[1] + 0.12], 0.13, false); pumpkin(g, [CORNER.bike[0] - 0.35, 0, CORNER.bike[1] + 0.2], 0.11, false);
      blockFloor(CORNER.board[0] + 0.15, CORNER.board[1], 0.4); blockFloor(CORNER.bike[0] + 0.05, CORNER.bike[1], 0.45);
      const leaf = new THREE.Shape(); leaf.moveTo(0, -0.04);
      [[0.012, -0.012], [0.04, -0.005], [0.022, 0.008], [0.032, 0.03], [0.008, 0.022], [0, 0.045], [-0.008, 0.022], [-0.032, 0.03], [-0.022, 0.008], [-0.04, -0.005], [-0.012, -0.012]].forEach(([a, b]) => leaf.lineTo(a, b));
      const leafGeo = new THREE.ShapeGeometry(leaf); leafGeo.rotateX(-Math.PI / 2);
      const r = rnd(1126), at = [];
      for (const bz of [-2.4, 0.6]) for (const lx of [-3.65, -2.2, -0.6, 1.0, 2.45]) for (let i = 0; i < 3; i++) at.push([[lx + (r() - 0.5) * 0.28, 0.749 + i * 0.0015, bz + (r() - 0.5) * 0.6], [0, r() * 6.3, 0], 0.9 + r() * 0.6]);
      for (let i = 0; i < 3; i++) at.push([[-6.1 + (r() - 0.5) * 0.4, 0.752 + i * 0.0015, 0.1 + r() * 0.1], [0, r() * 6.3, 0], 1 + r() * 0.4]);
      const leafColors = [0xb5321f, 0xd9822b, 0xe0b23a, 0x8a4b23];
      leafColors.forEach((c, k) => many(g, leafGeo, std(c, { roughness: 0.8, side: THREE.DoubleSide }), at.filter((_, i) => i % leafColors.length === k)));
    },
    christmas(g) {
      // a tree with lights and a star in the corner by the bike, presents under it and by the board,
      // and string lights on the walls
      const [tx, tz] = CORNER.bike, tree = groupAt(g, [tx, 0, tz], FACE);
      cyl(tree, std(0x5a3a22), [0, 0.12, 0], 0.07, 0.24); cyl(tree, std(0x8c2f2f, { roughness: 0.6 }), [0, 0.08, 0], 0.2, 0.16, 0.22);
      const needles = std(0x1f5a32, { roughness: 0.8 });
      const tiers = [[0.3, 0.62, 0.8], [0.75, 0.5, 0.65], [1.15, 0.38, 0.55], [1.5, 0.25, 0.45]];
      tiers.forEach(([y, r, h]) => { const c = mesh(new THREE.ConeGeometry(r, h, 14), needles, tree); c.position.y = y + h / 2; });
      const outside = (y) => Math.max(0, ...tiers.map(([y0, r, h]) => (y >= y0 && y <= y0 + h ? r * (1 - (y - y0) / h) : 0)));
      const bulbColors = [0xff4a4a, 0xffd34a, 0x4ac2ff, 0x7dff6a], lit = bulbColors.map((c) => glow(c)), bulbAt = bulbColors.map(() => []);
      for (let i = 0; i < 44; i++) { const k = i / 44, y = 0.36 + k * 1.55, rr = outside(y) + 0.015, a = k * Math.PI * 9; bulbAt[i % 4].push([[Math.sin(a) * rr, y, Math.cos(a) * rr], null, 1]); }
      const bulb = new THREE.SphereGeometry(0.028, 8, 6), wallBulb = new THREE.SphereGeometry(0.045, 8, 6);
      lit.forEach((m, k) => many(tree, bulb, m, bulbAt[k]));
      const star = new THREE.Shape();
      for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2, r = i % 2 ? 0.05 : 0.12; if (i) star.lineTo(Math.sin(a) * r, Math.cos(a) * r); else star.moveTo(0, r); }
      const starGeo = new THREE.ExtrudeGeometry(star, { depth: 0.025, bevelEnabled: false }); starGeo.translate(0, 0, -0.0125);
      const starMesh = mesh(starGeo, glow(0xffe27a), tree, false); starMesh.position.y = 2.07;
      [[0.62, 0.2, [0.3, 0.22, 0.3], 0xc8102e, 0xf2d16b], [0.3, 0.55, [0.24, 0.3, 0.24], 0x2e7d4f, 0xffffff], [-0.15, 0.62, [0.36, 0.16, 0.26], 0x2f5fb3, 0xe8c45a]]
        .forEach(([dx, dz, size, col, rib]) => present(g, [tx + dx, tz + dz], size, col, rib));
      present(g, CORNER.board, [0.32, 0.24, 0.28], 0xc8102e, 0xf2d16b); present(g, [CORNER.board[0] + 0.36, CORNER.board[1] + 0.08], [0.22, 0.3, 0.22], 0x2f5fb3, 0xffffff);
      blockFloor(tx + 0.1, tz + 0.1, 0.75); blockFloor(CORNER.board[0] + 0.15, CORNER.board[1], 0.3);
      wallLine(g, 0x1d2b1d, 0.006);
      const wallLit = bulbColors.map((c) => glow(c));
      alongWalls(0.24, bulbColors, (p) => [[p[0], p[1] - 0.04, p[2]], null, 1]).forEach((at, k) => many(g, wallBulb, wallLit[k], at));
      const on = bulbColors.map((c) => C(c)), dim = on.map((c) => c.clone().multiplyScalar(0.35));
      decor.anims.push((t) => {
        const step = Math.floor(t * 1.6);
        lit.forEach((m, k) => m.color.copy((step + k) % 4 === 0 ? dim[k] : on[k]));
        wallLit.forEach((m, k) => m.color.copy((step + k) % 2 ? dim[k] : on[k]));
        starMesh.material.color.setScalar(0.9 + Math.sin(t * 2) * 0.1);
      });
    }
  };
  // a bunny, sitting: body, head, long ears and a tail
  function bunny(parent, p, s) {
    const g = groupAt(parent, p, FACE + 0.6, s), fur = std(0xf1ece4, { roughness: 0.9 }), pink = std(0xf2a7b8, { roughness: 0.7 });
    ball(g, fur, [0, 0.16, 0], 0.15, [1, 1.05, 1.15]); ball(g, fur, [0, 0.34, 0.08], 0.1);
    for (const sx of [-1, 1]) { const e = ball(g, fur, [sx * 0.04, 0.5, 0.06], 0.03, [1, 3.4, 0.6]); e.rotation.z = -sx * 0.18; const i = ball(g, pink, [sx * 0.04, 0.5, 0.075], 0.018, [1, 3.6, 0.4]); i.rotation.z = -sx * 0.18; ball(g, std(0x1a1414), [sx * 0.04, 0.37, 0.17], 0.012); ball(g, fur, [sx * 0.07, 0.03, 0.12], 0.05, [0.8, 0.5, 1.4]); }
    ball(g, pink, [0, 0.33, 0.18], 0.012); ball(g, std(0xffffff, { roughness: 1 }), [0, 0.12, -0.17], 0.05);
  }

  function takeDown() {
    if (!decor.group) return;
    scene.remove(decor.group);
    const seen = new Set();
    decor.group.traverse((o) => {
      for (const m of [].concat(o.material || [])) if (m && !seen.has(m)) { seen.add(m); if (m.map) m.map.dispose(); m.dispose(); }
      if (o.geometry && !Object.values(G).includes(o.geometry) && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
    });
    decor.cells.forEach(([grid, c]) => { grid[c] = 0; });
    Object.assign(decor, { group: null, key: null, year: null, anims: [], cells: [], confetti: null, confettiUntil: 0, egg: null, flagMat: null });
    faceMat = null;
  }
  function putUp(h) {
    takeDown();
    if (h && BUILD[h.key]) build(h);
    replanWalks();
  }
  function build(h) {
    const g = new THREE.Group(); g.name = 'decorations:' + h.key;
    BUILD[h.key](g, h.year);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    scene.add(g);
    Object.assign(decor, { group: g, key: h.key, year: h.year });
    if (h.key === 'newyear' && h.preview) previewConfetti();
  }
  // A preview of New Year's drops the midnight confetti for half a minute, also when New Year's is up already.
  function previewConfetti() { if (decor.key === 'newyear') decor.confettiUntil = performance.now() + 30000; }
  function flagMaterial() {
    const c = makeCanvas(152, 80), x = c.getContext('2d');
    for (let i = 0; i < 13; i++) { x.fillStyle = i % 2 ? '#f4f4f4' : '#c8102e'; x.fillRect(0, (i * 80) / 13, 152, 80 / 13 + 0.5); }
    x.fillStyle = '#1f3a93'; x.fillRect(0, 0, 62, 43); x.fillStyle = '#fff';
    for (let j = 0; j < 4; j++) for (let i = 0; i < 5; i++) { x.beginPath(); x.arc(7 + i * 12 + (j % 2) * 6, 6 + j * 10, 1.6, 0, Math.PI * 2); x.fill(); }
    return new THREE.MeshStandardMaterial({ map: tex(c), roughness: 0.7, side: THREE.DoubleSide });
  }
  function decorNow() { return HOL ? HOL.shown(new Date(), decorOn, decorPreview) : null; }
  function applyDecor() {
    const h = decorNow();
    if (h ? h.key !== decor.key || h.year !== decor.year : decor.key) putUp(h);
    return decorState();
  }
  function decorState() {
    return { on: decorOn, preview: decorPreview || null, showing: decor.key, year: decor.key === 'newyear' ? decor.year : null, next: HOL ? HOL.holidayOn(new Date()) : null, confetti: !!(decor.confetti && decor.confetti.m.visible) };
  }
  // The switch, kept in this browser: 'on' or 'off'. A preview: a holiday's key, or 'auto' for the date.
  function setHoliday(v) {
    if (v === 'on' || v === 'off') { decorOn = v === 'on'; try { localStorage.setItem(DECOR_KEY, v); } catch (e) { /* no storage */ } }
    else if (v === 'auto' || v === '' || v === null) decorPreview = '';
    else if (HOL && HOL.KEYS.includes(v)) decorPreview = v;
    else if (v !== undefined) return Object.assign({ ok: false, error: 'bad_param', message: 'Send on, off, auto or one of ' + (HOL ? HOL.KEYS.join(', ') : '') + '.' }, decorState());
    applyDecor();
    if (v === 'newyear') previewConfetti();
    return decorState();
  }
  // Confetti falls for ten minutes from midnight on New Year's Day, and for half a minute in a preview.
  function tickDecor(real, nowMs) {
    if (nowMs - decor.checkedAt > 20000) { decor.checkedAt = nowMs; applyDecor(); }
    if (!decor.group) return;
    const t = nowMs / 1000;
    if (!reduce) for (const a of decor.anims) a(t);
    const cf = decor.confetti; if (!cf) return;
    const d = new Date(), midnight = d.getMonth() === 0 && d.getDate() === 1 && d.getHours() === 0 && d.getMinutes() < 10;
    const falling = midnight || nowMs < decor.confettiUntil;
    if (!falling && !cf.m.visible) return;
    let live = 0;
    cf.bits.forEach((b, i) => {
      if (!b.live && falling && (reduce || Math.random() < real * 0.3)) {  // under reduced motion it lies still on the floor
        b.live = true; b.lie = 0; b.v = rand(0.35, 0.6);
        b.p.set(rand(-6.5, 6.5), reduce ? 0.004 : rand(3.9, 4.4), rand(-4.6, 4.6)); b.r.set(reduce ? -Math.PI / 2 : rand(0, 6), 0, rand(0, 6));
      }
      if (b.live && !reduce) {
        if (b.p.y > 0.01) { b.p.y = Math.max(0.01, b.p.y - b.v * real); b.p.x += Math.sin(t * 2 + i) * 0.15 * real; b.r.x += b.spin.x * real; b.r.y += b.spin.y * real; b.r.z += b.spin.z * real; if (b.p.y === 0.01) b.r.set(-Math.PI / 2, 0, b.r.z); }
        else if ((b.lie += real) > 6) b.live = false;  // a bit on the floor goes after a while, and falls again
      }
      if (b.live && !falling && (reduce || b.p.y <= 0.01)) b.live = false;
      dummy.position.copy(b.p); dummy.rotation.copy(b.r); dummy.scale.setScalar(b.live ? 1 : 0); dummy.updateMatrix();
      cf.m.setMatrixAt(i, dummy.matrix); if (b.live) live++;
    });
    cf.m.visible = live > 0; cf.m.instanceMatrix.needsUpdate = true;
  }
  applyDecor();

  // ---------- the loop ----------
  function resize() {
    if (!renderer) return;
    const r = stage.getBoundingClientRect(); const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize); resize();
  function applyPart() {
    const P = PARTS[part];
    hemi.color.set(C(P.hemi[0])); hemi.groundColor.set(C(P.hemi[1])); hemi.intensity = P.hemi[2]; amb.intensity = P.amb;
    sun.color.set(C(P.sun[0])); sun.intensity = P.sun[1]; fill.intensity = P.fill;
    if (part === 'evening') sun.position.set(-11, 4.5, -2); else sun.position.set(-11, 9.5, 2.5);
    lamps.forEach((l) => { l.intensity = P.lamps; });
    bulbMat.emissiveIntensity = 0.4 + P.lamps * 1.4;
    neonLight.intensity = part === 'day' ? 0.3 : 0.9;
    if (renderer) renderer.toneMappingExposure = P.exposure;
    drawSkyline();
  }
  applyPart();
  function setTime(p) { part = PARTS[p] ? p : partNow(); applyPart(); if (window.OfficeLook) window.OfficeLook.part(part); emit('time', { time: part }); return part; }
  // The baked look, with ?look=baked (office/look.js). It needs to know what moves, so it never bakes it.
  if (window.OfficeLook && renderer) {
    window.OfficeLook.attach({
      scene, camera, renderer, sun, hemi, amb, fill, part: () => part,
      movers: () => [...people.map((w) => w.fig.root), boss.fig.root, ...Object.values(DESKS).flatMap((d) => [d.chair, d.mug]), ...tablePaddles, ppBall]
    });
  }

  let last = performance.now(), introT = 0, built = false;
  const camGoal = new THREE.Vector3();
  // ---------- the director: the trailer (office/trailer.js) moves the camera itself ----------
  // direct({ pos, target, fov }) holds the camera there and turns the mouse off; direct(null) gives
  // it back. where(name) says where a thing is, so a shot can point at it while it moves.
  // A key light rides with the camera, for close-ups of faces lit from behind: key is how bright.
  let directed = false;
  const lookAt = new THREE.Vector3();
  const keyLight = new THREE.PointLight(C(0xffe6cc), 0, 4, 2); scene.add(keyLight);
  function direct(c) {
    if (!c) { directed = false; keyLight.intensity = 0; if (controls) { controls.enabled = true; camera.position.copy(HOME); controls.target.copy(TARGET); } return false; }
    directed = true; introCam = false; follow = null; if (controls) controls.enabled = false;
    camera.position.set(c.pos[0], c.pos[1], c.pos[2]);
    if (c.fov && c.fov !== camera.fov) { camera.fov = c.fov; camera.updateProjectionMatrix(); }
    camera.lookAt(lookAt.set(c.target[0], c.target[1], c.target[2]));
    keyLight.intensity = c.key || 0; keyLight.position.copy(camera.position); keyLight.position.y += 0.25;
    return true;
  }
  const xyz = (v) => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
  function where(name) {
    const v = new THREE.Vector3(), n = String(name || '');
    if (n.startsWith('screen:')) {  // the middle of a person's first monitor, and the way it faces
      const w = byId[n.slice(7)], d = w && DESKS[w.desk]; if (!d) return null;
      const g = d.screens[0].group; g.updateMatrixWorld(); g.localToWorld(v.set(0, 0.38, 0.01));
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(g.getWorldQuaternion(new THREE.Quaternion()));
      return { at: xyz(v), facing: xyz(f) };
    }
    const fixed = { neon: neon.position, cake: CAKE_AT, espresso: espresso.getWorldPosition(v.clone()), pingpong: pp.position, city: backdrop.position, clock: clockFace.position };
    if (fixed[n]) return { at: xyz(fixed[n]) };
    const w = n === 'manager' ? boss : byId[n];  // a person: their head, and the way they face
    if (!w || !w.present) return null;
    w.fig.head.getWorldPosition(v);
    return { at: xyz(v), facing: [+Math.sin(w.yaw).toFixed(3), 0, +Math.cos(w.yaw).toFixed(3)] };
  }
  function tick(dt) {
    worldT += dt;
    for (const w of people) if (w.present) tickWorker(w, dt);
    tickBoss(dt);
    tickSteam(dt); tickGame(dt); tickParty();
    // stale work: nothing for 15 minutes means the hook missed the end
    const now = Date.now();
    if (now - lastStale > 5000) { lastStale = now; for (const w of people) if (w.task && !w.waiting && now - w.task.lastAt > 15 * 60 * 1000) finish(w, 'quiet', 'world');
      // a session in another terminal can close without saying so; give its person back
      for (const S of [...sessions.values()]) if (!S.terminal && now - S.lastAt > 30 * 60 * 1000 && !(S.who && (byId[S.who].task || byId[S.who].waiting))) unseat(S); }
  }
  let lastStale = 0;
  let lastFrameAt = 0;
  function frame(nowMs) {
    requestAnimationFrame(frame);
    lastFrameAt = performance.now();
    const real = Math.min(0.1, (nowMs - last) / 1000); last = nowMs;
    const dt = real * speed;
    if (dt > 0) tick(dt);
    for (const w of people) applyPose(w, dt);
    if (boss.present) applyPose(boss, dt);
    if (!built && !renderer) { built = true; emit('office.live', {}); readyWaiters.splice(0).forEach((r) => r(snapshot())); }
    if (!renderer) return;
    if (introCam) { introT += real / 3.2; const k = 1 - Math.pow(1 - Math.min(1, introT), 3); camera.position.lerpVectors(START, HOME, k); if (introT >= 1) introCam = false; }
    if (follow && controls && !directed) { follow.fig.root.getWorldPosition(camGoal); camGoal.y = 0.9; controls.target.lerp(camGoal, Math.min(1, real * 3)); }
    if (controls && !directed) { controls.update(); const t = controls.target; t.x = clamp(t.x, -6.5, 6.5); t.z = clamp(t.z, -4.5, 4.5); t.y = clamp(t.y, 0, 2.5); }
    { const before = clockMin; drawClock(); if (clockMin !== before && before !== -1) clockMinChanged = true; }
    if (boardDirty) { drawBoard(); boardDirty = false; }
    tickScreens();
    tickTags();
    tickDecor(real, nowMs);
    if (!(window.OfficeLook && window.OfficeLook.render(renderer))) renderer.render(scene, camera);  // the baked look's effects draw it
    if (!built) { built = true; emit('office.live', {}); readyWaiters.splice(0).forEach((r) => r(snapshot())); }
  }
  // While the page is not drawn (a hidden tab, a hidden side panel, a covered window) the
  // browser stops calling frame(), but hooks keep arriving. Keep the room's plans moving
  // in the background so people are in the right place when it shows again.
  setInterval(() => {
    if (performance.now() - lastFrameAt < 900) return;
    const nowMs = performance.now(), real = Math.min(2, (nowMs - last) / 1000); last = nowMs;
    for (let k = 0; k < Math.ceil(real / 0.05); k++) tick(Math.min(0.05, real) * speed);
    if (!built) { built = true; readyWaiters.splice(0).forEach((r) => r(snapshot())); }
  }, 1000);
  const readyWaiters = [];
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { drawNeon(); boardDirty = true; clockMin = -1; drawClock(); people.forEach(markScreen); });

  // ---------- window.run ----------
  const run = {
    version: '0.1.0', world: 'office',
    do: doAction,
    ready: () => built ? Promise.resolve(snapshot()) : new Promise((r) => readyWaiters.push(r)),
    state: snapshot,
    events: (since) => events.filter((e) => e.seq > (since || 0)),
    on,
    actions: () => Object.entries(ACTIONS).map(([name, a]) => ({ name, description: a.desc, params: a.params })),
    roster: () => ACTIONS.roster.run().people,
    focus: (id) => { follow = id ? byId[id] || null : null; introCam = false; return !!follow; },
    view: (name) => setView(name),
    direct,
    where,
    // Brings the whole roster into the room at once, for the trailer.
    cast: () => { people.forEach((w) => { w.extra = false; if (!w.present) { w.present = true; w.fig.root.visible = true; placeAway(w); } }); return people.length; },
    tags: (on) => { showTags = on == null ? !showTags : !!on; return showTags; },
    time: setTime,
    holiday: setHoliday,
    debug: (id) => { const w = id === boss.id ? boss : byId[id]; return w && { pos: [+w.pos.x.toFixed(2), +w.pos.z.toFixed(2)], yaw: +w.yaw.toFixed(2), spot: w.spot, seated: w.seated, fidget: w.fidget, swivel: +w.swivel.toFixed(2), phone: w.phone.visible, hat: w.hat.visible, step: w.step && { t: w.step.t, key: w.step.key, el: +(w.step.el || 0).toFixed(1), left: w.step.path ? w.step.path.length : null }, steps: w.steps.map((s) => s.t + (s.key ? ':' + s.key : '')) }; }
  };
  ACTIONS.ready.run = () => run.ready().then((s) => ({ ok: true, people: s.people, busy: s.busy }));
  Object.keys(ACTIONS).forEach((k) => { if (!run[k]) run[k] = (o) => doAction(Object.assign({ action: k }, o || {})); });
  window.run = run;
  // nobody starts at a computer, and only the first few are here
  people.forEach((w, i) => { w.extra = i >= (ROSTER.startWith || 3); w.present = !w.extra; w.fig.root.visible = w.present; if (w.present) placeAway(w); });
  emit('office.started', { people: people.length, time: part });
  requestAnimationFrame(frame);
})();
