// The baked look: ?look=baked in the address. Blender bakes the evening light that bounces around
// the loft into two textures, office/baked/light.png and office/baked/ao.png, for the parts of the
// room that never move. The page swaps those parts for a copy that carries the textures, and the
// sun, the lamps, the people and everything that moves stay lit live. office/baked/README.md says
// how to bake again.
// The baked look also draws through a few effects, unless the address has fx=off: bloom, so the
// bulbs, the neon and the windows glow; a warm haze that grows with distance; and a colour grade with
// a vignette. They are three.js r128's own add-ons, from the CDN at that exact version.
// Also loaded with require by the tests, so the rules for what is baked are checked without a browser.
(function (root) {
  'use strict';
  const BASE = 'baked/';
  const LOADER = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js';
  const MIN_SIZE = 0.3;  // metres across. Anything smaller stays lit live: it is cheap and some of it moves.
  const ADDONS = ['shaders/CopyShader.js', 'shaders/LuminosityHighPassShader.js', 'postprocessing/EffectComposer.js',
    'postprocessing/RenderPass.js', 'postprocessing/ShaderPass.js', 'postprocessing/UnrealBloomPass.js']
    .map((f) => 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/' + f);
  // The effects' settings. The haze colour and density are for the evening; the grade warms, adds a
  // little contrast and darkens the corners, then turns the picture from linear light into sRGB.
  const FX = { bloom: { strength: 0.7, radius: 0.55, threshold: 0.72 }, haze: { colour: 0x6b4430, density: 0.022 },
    grade: { warmth: 0.06, contrast: 1.16, saturation: 1.05, vignette: 0.6 } };

  function param(search, name) {
    try { return new URLSearchParams(search || '').get(name); } catch (e) { return null; }
  }
  function wanted(search) { return param(search, 'look') === 'baked' ? 'baked' : 'live'; }
  // The effects come with the baked look, unless fx=off.
  function wantFx(search) { return wanted(search) === 'baked' && param(search, 'fx') !== 'off'; }

  // A mesh's key: where it is, how it is turned and sized, how many points it has, and its colours.
  // The room is built the same way on every load, so a part that never moves has the same key each time.
  const r2 = (x) => Math.round(x * 100);
  function mats(mesh) { return Array.isArray(mesh.material) ? mesh.material : [mesh.material]; }
  function meshKey(mesh) {
    const e = mesh.matrixWorld.elements;
    const at = [12, 13, 14, 0, 1, 2, 4, 5, 6, 8, 9, 10].map((i) => r2(e[i])).join(',');
    const pos = mesh.geometry && mesh.geometry.attributes && mesh.geometry.attributes.position;
    const colours = mats(mesh).map((m) => (m && m.color ? m.color.getHexString() : '-')).join('+');
    return at + '|' + (pos ? pos.count : 0) + '|' + colours;
  }
  // A material's name in the baked copy: the key of the first part that uses it, and its slot.
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
  // Baked: a shown mesh that does not move, is lit (not a screen, sign or sky), is not see-through,
  // and is at least MIN_SIZE across. People, chair seats, mugs, paddles and the ball are movers.
  function bakeable(mesh, movers) {
    if (!mesh || !mesh.isMesh || mesh.isInstancedMesh || mesh.isSkinnedMesh) return false;
    if (!shown(mesh) || under(mesh, movers)) return false;
    if (!mats(mesh).every((m) => m && m.isMeshStandardMaterial && !m.transparent && m.opacity >= 1)) return false;
    return size(mesh) >= MIN_SIZE;
  }

  // ---------- in the page ----------
  const state = { look: 'live', baked: false, status: 'off', hidden: 0, missing: 0, fx: 'off', error: null };
  let ctx = null, room = null, parts = [], meta = null, wantBaked = false, loading = null;
  let fxWanted = false, fxLoading = null, composer = null, liveFog = null;
  const view = { w: 0, h: 0 };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script'); s.src = src; s.onload = resolve;
      s.onerror = () => reject(new Error('could not load ' + src)); document.head.appendChild(s);
    });
  }
  function loadTexture(url) { return new Promise((resolve, reject) => new THREE.TextureLoader().load(url, resolve, undefined, () => reject(new Error('could not load ' + url)))); }

  function moverSet() { return new Set(ctx.movers().filter(Boolean)); }
  function liveParts() {
    const movers = moverSet(), found = [];
    ctx.scene.updateMatrixWorld(true);
    ctx.scene.traverse((o) => { if (bakeable(o, movers)) found.push(o); });
    return found;
  }

  async function load() {
    if (!THREE.GLTFLoader) await loadScript(LOADER);
    meta = await (await fetch(BASE + 'bake.json')).json();
    const [gltf, light, ao] = await Promise.all([
      new Promise((resolve, reject) => new THREE.GLTFLoader().load(BASE + 'room.glb', resolve, undefined, reject)),
      loadTexture(BASE + 'light.png'), loadTexture(BASE + 'ao.png')
    ]);
    light.flipY = false; light.encoding = THREE.sRGBEncoding;
    ao.flipY = false;
    // The live materials, by the name the bake gave them, so the copy keeps their textures and colours.
    const keys = new Set(meta.keys), byName = {};
    parts = liveParts().filter((m) => keys.has(m.userData.bakeKey = meshKey(m)));
    for (const m of parts) mats(m).forEach((mat, i) => { byName[materialName(m.userData.bakeKey, i)] = mat; });
    state.missing = keys.size - parts.length;
    room = gltf.scene;
    room.traverse((o) => {
      if (!o.isMesh) return;
      const live = byName[o.material.name];
      const mat = live ? live.clone() : o.material;
      mat.lightMap = light; mat.lightMapIntensity = meta.lightMapIntensity;
      mat.aoMap = ao; mat.aoMapIntensity = meta.aoMapIntensity;
      o.material = mat; o.castShadow = true; o.receiveShadow = true;
    });
    room.visible = false;
    ctx.scene.add(room);
  }

  function lights(on) {
    const { sun, hemi, amb, fill } = ctx;
    if (!on) return;  // applyPart has just set the live values
    const s = meta.sun;
    sun.position.set(sun.target.position.x + s.from[0], sun.target.position.y + s.from[1], sun.target.position.z + s.from[2]);
    sun.color.set(s.color); sun.intensity = s.intensity;
    hemi.intensity *= meta.ambientScale; amb.intensity *= meta.ambientScale; fill.intensity *= meta.ambientScale;
  }

  function show(on) {
    if (!room) return;
    parts.forEach((m) => { m.visible = !on; });
    room.visible = on;
    lights(on);
    haze(on && fxWanted);
    state.baked = on; state.hidden = on ? parts.length : 0;
    state.status = on ? 'baked' : 'live';
    state.fx = on && fxWanted ? (composer ? 'on' : 'loading') : 'off';
    if (on && fxWanted && !composer && !fxLoading) {
      fxLoading = loadFx().then(() => { state.fx = state.baked ? 'on' : 'off'; }).catch((e) => {
        fxWanted = false; state.fx = 'off'; haze(false); state.error = String(e && e.message || e);
        console.warn('The baked look\'s effects could not load, so it draws without them:', state.error);
      });
    }
  }

  // ---------- the effects ----------
  // The haze, and the background colour in linear light: the effects turn the whole picture into sRGB
  // at the end, the background too, so without this the dark void around the loft would turn grey.
  function haze(on) {
    const scene = ctx.scene;
    if (on) {
      if (!liveFog) liveFog = { fog: scene.fog, background: scene.background };
      scene.fog = new THREE.FogExp2(FX.haze.colour, FX.haze.density);
      if (liveFog.background && liveFog.background.isColor) scene.background = liveFog.background.clone().convertSRGBToLinear();
    } else if (liveFog) {
      scene.fog = liveFog.fog; scene.background = liveFog.background; liveFog = null;
    }
  }
  // Grade, vignette and sRGB in one pass, last, so the picture reaches the screen once.
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
  async function loadFx() {
    for (const src of ADDONS) await loadScript(src);
    const r = ctx.renderer, w = Math.max(1, view.w), h = Math.max(1, view.h);
    // The scene is drawn into a target first, so it keeps its edges smooth only with multisampling.
    const target = r.capabilities.isWebGL2 && THREE.WebGLMultisampleRenderTarget
      ? new THREE.WebGLMultisampleRenderTarget(w, h, { format: THREE.RGBAFormat }) : undefined;
    const c = new THREE.EffectComposer(r, target);
    c.addPass(new THREE.RenderPass(ctx.scene, ctx.camera));
    c.addPass(new THREE.UnrealBloomPass(new THREE.Vector2(w, h), FX.bloom.strength, FX.bloom.radius, FX.bloom.threshold));
    const grade = new THREE.ShaderPass(GRADE);
    for (const k of ['warmth', 'contrast', 'saturation', 'vignette']) grade.uniforms[k].value = FX.grade[k];
    c.addPass(grade);
    composer = c;
    view.w = view.h = 0;  // the next frame sets the composer's size
  }
  // The room's frame calls this. It draws through the effects and says so, or draws nothing and says no.
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

  // The room calls part() after each change of Light. The bake is of the evening, so another Light
  // shows the room lit live, and evening brings the baked look back.
  function part(name) {
    if (!wantBaked) return;
    if (!room) {
      if (!loading) {
        state.status = 'loading';
        loading = load().then(() => show(ctx.part() === 'evening')).catch((e) => {
          state.status = 'live'; state.error = String(e && e.message || e);
          console.warn('The baked look could not load, so the room is lit live:', state.error);
        });
      }
      return;
    }
    show(name === 'evening');
  }

  function attach(c) {
    ctx = c;
    wantBaked = wanted(location.search) === 'baked';
    fxWanted = wantFx(location.search);
    state.look = wantBaked ? 'baked' : 'live';
    if (c.renderer) { const v = c.renderer.getSize(new THREE.Vector2()); view.w = v.x; view.h = v.y; }
    if (wantBaked) part(c.part());
  }

  const api = { wanted, wantFx, meshKey, materialName, bakeable, MIN_SIZE, FX, ADDONS, state, attach, part, render, liveParts: () => liveParts() };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OfficeLook = api;
})(typeof window !== 'undefined' ? window : this);
