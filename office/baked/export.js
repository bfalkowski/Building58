#!/usr/bin/env node
// Step 1 of a bake (office/baked/README.md): open the room in headless Chrome, pick the parts
// office/look.js would bake, and write them, with their textures, to a GLB for Blender, plus the list of
// their keys and the room's lights. Nothing leaves this computer: three.js comes from node_modules.
// Usage: node office/baked/export.js <out folder> [chrome path]
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..', '..');
const MODULES = path.join(ROOT, 'node_modules');
const LOCAL = {
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js': 'three/build/three.min.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js': 'three/examples/js/controls/OrbitControls.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js': 'three/examples/js/loaders/GLTFLoader.js',
  'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js': '@xterm/xterm/lib/xterm.js',
  'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css': '@xterm/xterm/css/xterm.css',
  'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js'
};
const ORIGIN = 'http://room.local';
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

(async () => {
  const out = path.resolve(process.argv[2] || 'bake-work');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.argv[3] || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (LOCAL[url]) return route.fulfill({ path: path.join(MODULES, LOCAL[url]), contentType: TYPES['.js'] });
    if (!url.startsWith(ORIGIN)) return route.fulfill({ status: 200, body: '', contentType: 'text/css' });  // fonts: answered empty
    let p = decodeURIComponent(new URL(url).pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file, contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
  });
  await page.goto(ORIGIN + '/office/index.html?time=evening&holiday=off');
  await page.waitForFunction(() => window.run && window.OfficeLook, null, { timeout: 120000 });
  await page.evaluate(() => window.run.ready());
  await page.addScriptTag({ path: path.join(MODULES, 'three/examples/js/exporters/GLTFExporter.js') });

  const info = await page.evaluate(async () => {
    const L = window.OfficeLook;
    const parts = L.liveParts();
    const count = {};
    for (const m of parts) { const k = L.meshKey(m); count[k] = (count[k] || 0) + 1; }
    const unique = parts.filter((m) => count[L.meshKey(m)] === 1);  // two parts with one key cannot be told apart
    const copy = new THREE.Scene(), names = new Map(), keys = [];
    for (const m of unique) {
      const key = L.meshKey(m);
      const list = Array.isArray(m.material) ? m.material : [m.material];
      const named = list.map((mat, i) => {
        if (!names.has(mat)) { const c = mat.clone(); c.name = L.materialName(key, i); names.set(mat, c); }
        return names.get(mat);
      });
      const c = new THREE.Mesh(m.geometry, Array.isArray(m.material) ? named : named[0]);
      c.matrixAutoUpdate = false; c.matrix.copy(m.matrixWorld); c.name = key;
      copy.add(c); keys.push(key);
    }
    const lights = [];
    let scene = null;
    for (let o = parts[0]; o; o = o.parent) scene = o;
    scene.traverse((o) => { if (o.isPointLight) lights.push({ at: o.getWorldPosition(new THREE.Vector3()).toArray(), color: '#' + o.color.getHexString(), intensity: o.intensity }); });
    const glb = await new Promise((resolve) => new THREE.GLTFExporter().parse(copy, resolve, { binary: true, embedImages: true, maxTextureSize: 1024 }));
    const bytes = new Uint8Array(glb);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { b64: btoa(s), keys, lights, found: parts.length, materials: names.size };
  });
  fs.writeFileSync(path.join(out, 'static.glb'), Buffer.from(info.b64, 'base64'));
  const exported = { lights: info.lights, keys: info.keys };
  fs.writeFileSync(path.join(out, 'export.json'), JSON.stringify(exported, null, 1));
  console.log(`parts found ${info.found}, exported ${info.keys.length}, materials ${info.materials}, lamps ${info.lights.length}`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
