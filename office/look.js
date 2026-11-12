// The baked look: ?look=baked in the address. Blender bakes the evening light that bounces around
// the loft into two textures, office/baked/light.png and office/baked/ao.png, for the parts of the
// room that never move. The page swaps those parts for a copy that carries the textures, and the
// sun, the lamps, the people and everything that moves stay lit live. office/baked/README.md says
// how to bake again.
// Also loaded with require by the tests, so the rules for what is baked are checked without a browser.
(function (root) {
  'use strict';
  const BASE = 'baked/';
  const LOADER = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js';
  const MIN_SIZE = 0.3;  // metres across. Anything smaller stays lit live: it is cheap and some of it moves.

  function wanted(search) {
    let q = null;
    try { q = new URLSearchParams(search || '').get('look'); } catch (e) { q = null; }
    return q === 'baked' ? 'baked' : 'live';
  }

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
  const state = { look: 'live', baked: false, status: 'off', hidden: 0, missing: 0, error: null };
  let ctx = null, room = null, parts = [], meta = null, wantBaked = false, loading = null;

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
    state.baked = on; state.hidden = on ? parts.length : 0;
    state.status = on ? 'baked' : 'live';
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
    state.look = wantBaked ? 'baked' : 'live';
    if (wantBaked) part(c.part());
  }

  const api = { wanted, meshKey, materialName, bakeable, MIN_SIZE, state, attach, part, liveParts: () => liveParts() };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OfficeLook = api;
})(typeof window !== 'undefined' ? window : this);
