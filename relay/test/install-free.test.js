// The room runs with no install (CLAUDE.md, docs/constitution.md article 9). package.json has no
// runtime dependencies, and each library the pages load from a CDN names an exact version.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const CDNS = ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'esm.sh', 'cdn.skypack.dev', 'ga.jspm.io'];
const EXACT = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

// True when a CDN link names an exact version. On cdnjs the version is the folder after the name
// (three.js/r128). Elsewhere it is the npm way, name@1.2.3 or @scope/name@1.2.3.
function exact(url) {
  const u = new URL(url);
  if (u.hostname === 'cdnjs.cloudflare.com') {
    const v = u.pathname.match(/^\/ajax\/libs\/[^/]+\/([^/]+)\//);
    return !!v && (EXACT.test(v[1]) || /^r\d+$/.test(v[1]));
  }
  const rest = u.pathname.replace(/^\/(npm|gh\/[^/]+)\//, '/');
  const pkg = rest.match(/^\/((?:@[^/@]+\/)?[^/@]+)(?:@([^/]+))?/);
  return !!pkg && !!pkg[2] && EXACT.test(pkg[2]);
}

function filesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' || d.name.startsWith('.') ? [] : filesIn(p);
    return /\.(js|html|css)$/.test(d.name) ? [p] : [];
  });
}

test('package.json has no runtime dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(pkg.dependencies || {}), [], 'Make it a devDependency, or load it from a CDN at an exact version.');
});

test('each CDN link in office/ and shared/ names an exact version', () => {
  for (const ok of ['https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js', 'https://unpkg.com/@xterm/xterm@5.5.0/lib/xterm.js', 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js']) assert.ok(exact(ok), 'exact: ' + ok);
  for (const bad of ['https://cdn.jsdelivr.net/npm/three/build/three.js', 'https://cdn.jsdelivr.net/npm/three@0/build/three.js', 'https://unpkg.com/three@latest', 'https://unpkg.com/@xterm/xterm/lib/xterm.js', 'https://cdn.jsdelivr.net/npm/three@^0.160.0', 'https://cdnjs.cloudflare.com/ajax/libs/d3/latest/d3.min.js']) assert.ok(!exact(bad), 'not exact: ' + bad);
  const found = [];
  let seen = 0;
  for (const top of ['office', 'shared']) {
    for (const file of filesIn(path.join(REPO, top))) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/https?:\/\/([\w.-]+)\/[^\s"'`)<>]*/g)) {
        if (!CDNS.includes(m[1])) continue;
        seen++;
        if (!exact(m[0])) found.push(path.relative(REPO, file) + ': ' + m[0]);
      }
    }
  }
  assert.ok(seen > 0, 'the scan finds the CDN links the room page loads');
  assert.deepStrictEqual(found, [], 'Name the exact version, like three@0.160.0, not three, three@0 or three@latest.');
});
