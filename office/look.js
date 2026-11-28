// The baked look: ?look=baked in the address. Blender bakes the light that bounces around the loft,
// for each time of day, into textures (office/baked/light-evening.png, light-day.png, light-night.png),
// and how hidden each point is from open air into office/baked/ao.png, for the parts of the room that
// never move. The look follows the room's Light: day, evening or night. The page swaps those parts for a copy that carries the textures, and the
// sun, the lamps, the people and everything that moves stay lit live. office/baked/README.md says
// how to bake again.
// The baked look also draws through a few effects, unless the address has fx=off: bloom, so the
// bulbs, the neon and the windows glow; a haze that grows with distance; and a colour grade with a
// vignette, each set for the time of day. They are three.js r128's own add-ons, from the CDN at that
// exact version. Each file it loads has its hash in INTEGRITY, so the browser refuses a file that changed.
// Also loaded with require by the tests, so the rules for what is baked are checked without a browser.
(function (root) {
  'use strict';
  const BASE = 'baked/';
  const INTEGRITY = {
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js': 'sha384-fljlqkjWlmSFjkESkQvm77heIZpoWmXEOzlCA7kOpGUH+95Zk0yGfQieWM2q136E',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/shaders/CopyShader.js': 'sha384-nhO9toQuMo5osCuA0l+YFpSqscZWxDu251Bnho2gD3kSPv1neEwHg0LyEmrA+mPj',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/shaders/LuminosityHighPassShader.js': 'sha384-mY+ii969jnDCI2HjRHftH2NZVkIO5ZGUkcnGCg3oVJ3kVstWQXwerYWBg+nbUG4R',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/EffectComposer.js': 'sha384-GkidzTYmQg24v13sa3xhBBbvOLbVLO1QxfyKLdOWweQqNqS/iWwUst2T1fER2Xrg',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/RenderPass.js': 'sha384-2EpLreWSFuZsk4hcSplXLhlHd/wzvDNF907bTGIXSXM0SlhJNzy4YK0DhBFvkFEs',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/ShaderPass.js': 'sha384-I3lsvPeDJYFrEAzn/TA0yhc/SCYKwpyfyq8lKzHYKohu43H9f7xc/Q9ZWgSVUDl3',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/UnrealBloomPass.js': 'sha384-aVQ2QnWkoxhOefDB0YZB64OPVzujvccydpcC7UqMDJUK0ChwA382zOHmrWHGDRRa'
  };
  const [LOADER, ...ADDONS] = Object.keys(INTEGRITY);
  const MIN_SIZE = 0.3;
  const FX = {
    evening: { bloom: { strength: 0.7, radius: 0.55, threshold: 0.72 }, haze: { colour: 0x6b4430, density: 0.022 }, grade: { warmth: 0.06, contrast: 1.16, saturation: 1.05, vignette: 0.6 } },
    day: { bloom: { strength: 0.3, radius: 0.5, threshold: 0.85 }, haze: { colour: 0xb7c3cc, density: 0.011 }, grade: { warmth: 0.02, contrast: 1.08, saturation: 1.04, vignette: 0.35 } },
    night: { bloom: { strength: 0.95, radius: 0.6, threshold: 0.62 }, haze: { colour: 0x121a2b, density: 0.024 }, grade: { warmth: -0.04, contrast: 1.14, saturation: 0.98, vignette: 0.7 } }
  };

  function param(search, name) {
    try { return new URLSearchParams(search || '').get(name); } catch (e) { return null; }
  }
  function wanted(search) { return param(search, 'look') === 'baked' ? 'baked' : 'live'; }
  function wantFx(search) { return wanted(search) === 'baked' && param(search, 'fx') !== 'off'; }

  const r2 = (x) => Math.round(x * 100);
  function mats(mesh) { return Array.isArray(mesh.material) ? mesh.material : [mesh.material]; }
  function meshKey(mesh) {
    const e = mesh.matrixWorld.elements;
    const at = [12, 13, 14, 0, 1, 2, 4, 5, 6, 8, 9, 10].map((i) => r2(e[i])).join(',');
    const pos = mesh.geometry && mesh.geometry.attributes && mesh.geometry.attributes.position;
    const colours = mats(mesh).map((m) => (m && m.color ? m.color.getHexString() : '-')).join('+');
    return at + '|' + (pos ? pos.count : 0) + '|' + colours;
  }
  function materialName(key, slot) { return key + '#' + slot; }

  function under(obj, set) { for (let o = obj; o; o = o.parent) if (set.has(o)) return true; return false; }
  function shown(obj) { for (let o = obj; o; o = o.parent) if (!o.visible) return false; return true; }
  function size(mesh) {
    const g = mesh.geometry;
    if (!g) return 0;
    if (!g.boundingSphere && g.computeBoundingSphere) g.computeBoundingSphere();
    const e = mesh.matrixWorld.elements;
    const scale = Math.max(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10]));
    return g.boundingSphere ? g.boundingSphere.radius * 2 * scale : 0;
  }
  function bakeable(mesh, movers) {
    if (!mesh || !mesh.isMesh || mesh.isInstancedMesh || mesh.isSkinnedMesh) return false;
    if (!shown(mesh) || under(mesh, movers)) return false;
    if (!mats(mesh).every((m) => m && m.isMeshStandardMaterial && !m.transparent && m.opacity >= 1)) return false;
    return size(mesh) >= MIN_SIZE;
  }

  const state = { look: 'live', baked: false, time: null, status: 'off', hidden: 0, missing: 0, fx: 'off', error: null };
  let ctx = null, room = null, parts = [], meta = null, wantBaked = false, loading = null;
  let fxWanted = false, fxLoading = null, fxScripts = null, composer = null, liveFog = null, bloomPass = null, gradePass = null, aoMap = null;
  const lightMaps = {};
  const onGpu = new Set();
  const view = { w: 0, h: 0 };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script'); s.src = src; s.integrity = INTEGRITY[src]; s.crossOrigin = 'anonymous'; s.onload = resolve;
      s.onerror = () => reject(new Error('could not load ' + src)); document.head.appendChild(s);
    });
  }
  function loadTexture(url, encoding) {
    const done = (t) => { t.flipY = false; if (encoding) t.encoding = encoding; return t; };
    if (typeof createImageBitmap !== 'function' || !THREE.ImageBitmapLoader) {
      return new Promise((resolve, reject) => new THREE.TextureLoader().load(url, (t) => resolve(done(t)), undefined, () => reject(new Error('could not load ' + url))));
    }
    return new Promise((resolve, reject) => new THREE.ImageBitmapLoader().setOptions({ imageOrientation: 'none', premultiplyAlpha: 'none' }).load(url, (bitmap) => {
      const t = new THREE.Texture(bitmap); t.needsUpdate = true; resolve(done(t));
    }, undefined, () => reject(new Error('could not load ' + url))));
  }
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  function moverSet() { return new Set(ctx.movers().filter(Boolean)); }
  function liveParts() {
    const movers = moverSet(), found = [];
    ctx.scene.updateMatrixWorld(true);
    ctx.scene.traverse((o) => { if (bakeable(o, movers)) found.push(o); });
    return found;
  }

  async function load() {
    [, meta] = await Promise.all([THREE.GLTFLoader ? null : loadScript(LOADER), fetch(BASE + 'bake.json').then((r) => r.json())]);
    if (meta.times[ctx.part()]) lightMap(ctx.part()).catch(() => {});
    const [gltf, ao] = await Promise.all([
      new Promise((resolve, reject) => new THREE.GLTFLoader().load(BASE + 'room.glb', resolve, undefined, reject)),
      loadTexture(BASE + 'ao.png')
    ]);
    aoMap = ao;
    const keys = new Set(meta.keys), byName = {};
    parts = liveParts().filter((m) => keys.has(m.userData.bakeKey = meshKey(m)));
    for (const m of parts) mats(m).forEach((mat, i) => { byName[materialName(m.userData.bakeKey, i)] = mat; });
    state.missing = keys.size - parts.length;
    room = gltf.scene;
    room.traverse((o) => {
      if (!o.isMesh) return;
      const live = byName[o.material.name];
      const mat = live ? live.clone() : o.material;
      mat.aoMap = ao; mat.aoMapIntensity = meta.aoMapIntensity;
      o.material = mat; o.castShadow = true; o.receiveShadow = true;
    });
    room.visible = false;
    ctx.scene.add(room);
  }

  async function lightMap(time) {
    if (!lightMaps[time]) {
      lightMaps[time] = loadTexture(BASE + meta.times[time].light, THREE.sRGBEncoding);
    }
    return lightMaps[time];
  }

  function lights(time) {
    const { sun, hemi, amb, fill } = ctx, t = meta.times[time], s = t.sun;
    sun.position.set(sun.target.position.x + s.from[0], sun.target.position.y + s.from[1], sun.target.position.z + s.from[2]);
    sun.color.set(s.color); sun.intensity = s.intensity;
    hemi.intensity *= t.ambientScale; amb.intensity *= t.ambientScale; fill.intensity *= t.ambientScale;
  }

  async function show(time) {
    if (!room) return;
    const on = !!(time && meta.times[time]);
    if (on) {
      const map = await lightMap(time), k = meta.times[time].lightMapIntensity;
      if (!onGpu.has(map)) { ctx.renderer.initTexture(map); onGpu.add(map); await nextFrame(); }
      if (ctx.part() !== time) return;
      room.traverse((o) => { if (o.isMesh) { o.material.lightMap = map; o.material.lightMapIntensity = k; } });
      lights(time);
    }
    if (on) topUp(time);
    parts.forEach((m) => { m.visible = !on; });
    room.visible = on;
    haze(on && fxWanted ? time : null);
    tune(on ? time : null);
    state.baked = on; state.time = on ? time : null; state.hidden = on ? parts.length : 0;
    state.status = on ? 'baked' : 'live';
    state.fx = on && fxWanted ? (composer ? 'on' : 'loading') : 'off';
    if (on && fxWanted && !composer && !fxLoading) {
      fxLoading = loadFxScripts().then(buildFx).then(() => { tune(state.time); state.fx = state.baked ? 'on' : 'off'; }).catch((e) => {
        fxWanted = false; state.fx = 'off'; haze(null); state.error = String(e && e.message || e);
        console.warn('The baked look\'s effects could not load, so it draws without them:', state.error);
      });
    }
  }

  function hazeFog(time) { return new THREE.FogExp2(FX[time].haze.colour, FX[time].haze.density); }
  function haze(time) {
    const scene = ctx.scene;
    if (time) {
      if (!liveFog) {
        const grids = [];
        scene.traverse((o) => { if (o.type === 'GridHelper' && o.visible) grids.push(o); });
        liveFog = { fog: scene.fog, background: scene.background, grids };
      }
      liveFog.grids.forEach((g) => { g.visible = false; });
      scene.fog = hazeFog(time);
      if (liveFog.background && liveFog.background.isColor) scene.background = liveFog.background.clone().convertSRGBToLinear();
    } else if (liveFog) {
      scene.fog = liveFog.fog; scene.background = liveFog.background;
      liveFog.grids.forEach((g) => { g.visible = true; });
      liveFog = null;
    }
  }
  const GRADE = {
    uniforms: { tDiffuse: { value: null }, warmth: { value: 0 }, contrast: { value: 1 }, saturation: { value: 1 }, vignette: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'uniform sampler2D tDiffuse; uniform float warmth, contrast, saturation, vignette; varying vec2 vUv;',
      'vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }',
      'void main() {',
      '  vec3 c = texture2D(tDiffuse, vUv).rgb;',
      '  c *= vec3(1.0 + warmth, 1.0, 1.0 - warmth);',
      '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
      '  c = max(mix(vec3(l), c, saturation), 0.0);',
      '  c = max((c - 0.18) * contrast + 0.18, 0.0);',
      '  vec2 d = vUv - 0.5; c *= clamp(1.0 - vignette * dot(d, d) * 2.0, 0.0, 1.0);',
      '  gl_FragColor = vec4(toSRGB(clamp(c, 0.0, 1.0)), 1.0);',
      '}'
    ].join('\n')
  };
  function loadFxScripts() {
    if (!fxScripts) fxScripts = (async () => { for (const src of ADDONS) await loadScript(src); })();
    return fxScripts;
  }
  function buildFx() {
    if (composer) return;
    const r = ctx.renderer, size = r.getSize(new THREE.Vector2()), w = Math.max(1, size.x), h = Math.max(1, size.y);
    const target = r.capabilities.isWebGL2 && THREE.WebGLMultisampleRenderTarget
      ? new THREE.WebGLMultisampleRenderTarget(w, h, { format: THREE.RGBAFormat }) : undefined;
    const c = new THREE.EffectComposer(r, target), scenePass = new THREE.RenderPass(ctx.scene, ctx.camera);
    c.addPass(scenePass);
    bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(w, h), 0, 0, 1);
    c.addPass(bloomPass);
    gradePass = new THREE.ShaderPass(GRADE);
    c.addPass(gradePass);
    c.setPixelRatio(r.getPixelRatio()); c.setSize(w, h);
    view.w = size.x; view.h = size.y;
    scenePass.enabled = false; c.renderToScreen = false;
    c.render();
    scenePass.enabled = true; c.renderToScreen = true;
    const last = r.getRenderTarget();
    r.setRenderTarget(null);
    r.compile(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), gradePass.material), ctx.camera);
    r.setRenderTarget(last);
    composer = c;
  }

  async function warmUp(time) {
    const r = ctx.renderer, t = time && meta.times[time] ? time : null;
    r.initTexture(aoMap); await nextFrame();
    if (!t) return;
    const map = await lightMap(t);
    r.initTexture(map); onGpu.add(map); await nextFrame();
    room.traverse((o) => { if (o.isMesh) { o.material.lightMap = map; o.material.lightMapIntensity = meta.times[t].lightMapIntensity; } });
    if (fxWanted && fxScripts) await fxScripts.then(async () => { buildFx(); tune(t); await nextFrame(); }).catch(() => {});
    await precompile(t);
  }
  const compiled = new Set();
  function pending(t, asSwap) {
    const fx = !!(composer && fxWanted), inRoom = new Set([room]), todo = [], seen = new Set();
    asSwap(() => ctx.scene.traverse((o) => {
      if (!o.material || !shown(o) || (fx ? o.type === 'GridHelper' : !under(o, inRoom))) return;
      if (mats(o).some((m) => m && !compiled.has(m) && !seen.has(m))) { mats(o).forEach((m) => seen.add(m)); todo.push(o); }
    }));
    return { todo, seen };
  }
  function swapView(t) {
    const r = ctx.renderer, scene = ctx.scene, fx = !!(composer && fxWanted);
    const fog = fx ? hazeFog(t) : scene.fog, target = fx ? composer.renderTarget1 : null;
    return function asSwap(fn) {
      const was = { fog: scene.fog, target: r.getRenderTarget(), parts: parts.map((m) => m.visible), room: room.visible };
      parts.forEach((m) => { m.visible = false; }); room.visible = true; scene.fog = fog; r.setRenderTarget(target);
      try { return fn(); } finally {
        r.setRenderTarget(was.target); scene.fog = was.fog; room.visible = was.room;
        parts.forEach((m, i) => { m.visible = was.parts[i]; });
      }
    };
  }
  function compileBatch(asSwap, todo, from, budget) {
    let i = from;
    asSwap(() => {
      const out = [];
      ctx.scene.traverse((o) => { if (o.material) { out.push([o, o.material]); o.material = null; } });
      const own = new Map(out), start = performance.now();
      try {
        while (i < todo.length && performance.now() - start < budget) {
          const next = todo.slice(i, i + 8).filter((o) => own.has(o));
          i += 8;
          next.forEach((o) => { o.material = own.get(o); });
          ctx.renderer.compile(ctx.scene, ctx.camera);
          next.forEach((o) => { mats(o).forEach((m) => compiled.add(m)); o.material = null; });
        }
      } finally { out.forEach(([o, m]) => { o.material = m; }); }
    });
    return i;
  }
  async function precompile(t) {
    const asSwap = swapView(t);
    for (;;) {
      const { todo } = pending(t, asSwap);
      if (!todo.length) return;
      for (let i = 0; i < todo.length;) {
        i = compileBatch(asSwap, todo, i, 8);
        await nextFrame();
      }
    }
  }
  function topUp(t) {
    const asSwap = swapView(t), { todo } = pending(t, asSwap);
    compileBatch(asSwap, todo, 0, Infinity);
  }
  function tune(time) {
    if (!bloomPass || !time || !FX[time]) return;
    const f = FX[time];
    bloomPass.strength = f.bloom.strength; bloomPass.radius = f.bloom.radius; bloomPass.threshold = f.bloom.threshold;
    for (const k of ['warmth', 'contrast', 'saturation', 'vignette']) gradePass.uniforms[k].value = f.grade[k];
  }
  function render(renderer) {
    if (!composer || !state.baked || !fxWanted) return false;
    const v = renderer.getSize(new THREE.Vector2());
    if (v.x !== view.w || v.y !== view.h) {
      view.w = v.x; view.h = v.y;
      composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(v.x, v.y);
    }
    composer.render();
    return true;
  }

  function part(name) {
    if (!wantBaked) return;
    if (!room) {
      if (!loading) {
        state.status = 'loading';
        if (fxWanted) loadFxScripts().catch(() => {});
        loading = load().then(() => warmUp(ctx.part())).then(() => show(ctx.part())).catch((e) => {
          state.status = 'live'; state.error = String(e && e.message || e);
          console.warn('The baked look could not load, so the room is lit live:', state.error);
        });
      }
      return;
    }
    show(name).catch((e) => { state.error = String(e && e.message || e); console.warn('The baked look could not change time:', state.error); });
  }

  function attach(c) {
    ctx = c;
    wantBaked = wanted(location.search) === 'baked';
    fxWanted = wantFx(location.search);
    state.look = wantBaked ? 'baked' : 'live';
    if (c.renderer) { const v = c.renderer.getSize(new THREE.Vector2()); view.w = v.x; view.h = v.y; }
    if (wantBaked) part(c.part());
  }

  const api = { wanted, wantFx, meshKey, materialName, bakeable, MIN_SIZE, FX, ADDONS, INTEGRITY, state, attach, part, render, liveParts: () => liveParts() };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OfficeLook = api;
})(typeof window !== 'undefined' ? window : this);
