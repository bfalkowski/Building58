// The room runs with no install (CLAUDE.md, docs/constitution.md article 9). package.json has no
// runtime dependencies, and each library the pages load from a CDN names an exact version and carries its
// hash, so the browser refuses a CDN file that changed. Each is also in devDependencies at the same
// version, so npm audit (.github/workflows/audit.yml) checks what the page runs.
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

test('each CDN file in office/ and shared/ carries its sha384 hash', () => {
  const HASH = /^sha384-[A-Za-z0-9+/]{64}$/;
  const found = [];
  let seen = 0;
  for (const top of ['office', 'shared']) {
    for (const file of filesIn(path.join(REPO, top))) {
      const text = fs.readFileSync(file, 'utf8');
      const where = path.relative(REPO, file);
      if (file.endsWith('.html')) {
        for (const tag of text.matchAll(/<(?:script|link)\b[^>]*>/g)) {
          const url = tag[0].match(/\b(?:src|href)="(https?:\/\/([\w.-]+)\/[^"]*)"/);
          if (!url || !CDNS.includes(url[2])) continue;
          seen++;
          const hash = tag[0].match(/\bintegrity="([^"]*)"/);
          if (!hash || !HASH.test(hash[1]) || !/\bcrossorigin="anonymous"/.test(tag[0])) found.push(where + ': ' + url[1]);
        }
        continue;
      }
      if (text.startsWith('#!')) continue;
      for (const m of text.matchAll(/'(https?:\/\/([\w.-]+)\/[^']*)'(: '([^']*)')?/g)) {
        if (!CDNS.includes(m[2])) continue;
        seen++;
        if (!m[4] || !HASH.test(m[4])) found.push(where + ': ' + m[1]);
      }
    }
  }
  assert.ok(seen > 0, 'the scan finds the CDN files the room page loads');
  assert.deepStrictEqual(found, [], 'Add integrity="sha384-..." crossorigin="anonymous" to the tag, or a \'url\': \'sha384-...\' entry where a script loads it. Make the hash with: curl -sL URL | openssl dgst -sha384 -binary | openssl base64 -A');
});

// The npm package and version a CDN link names. cdnjs names three.js as three.js/r128, which is npm's three@0.128.0.
function pkgOf(url) {
  const u = new URL(url);
  if (u.hostname === 'cdnjs.cloudflare.com') {
    const m = u.pathname.match(/^\/ajax\/libs\/([^/]+)\/([^/]+)\//);
    if (!m) return null;
    const r = m[1] === 'three.js' && m[2].match(/^r(\d+)$/);
    return r ? { name: 'three', version: '0.' + r[1] + '.0' } : { name: m[1], version: m[2] };
  }
  const m = u.pathname.replace(/^\/npm\//, '/').match(/^\/((?:@[^/@]+\/)?[^/@]+)@([^/]+)/);
  return m ? { name: m[1], version: m[2] } : null;
}

test('each library the page loads from a CDN is in devDependencies at the same version, so npm audit checks it', () => {
  assert.deepStrictEqual(pkgOf('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'), { name: 'three', version: '0.128.0' });
  assert.deepStrictEqual(pkgOf('https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js'), { name: '@xterm/xterm', version: '5.5.0' });
  const dev = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).devDependencies || {};
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8')).packages || {};
  const found = [];
  let seen = 0;
  for (const top of ['office', 'shared']) {
    for (const file of filesIn(path.join(REPO, top))) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.startsWith('#!')) continue;
      for (const m of text.matchAll(/https?:\/\/([\w.-]+)\/[^\s"'`)<>]*/g)) {
        if (!CDNS.includes(m[1])) continue;
        const p = pkgOf(m[0]);
        if (!p) continue;
        seen++;
        const locked = (lock['node_modules/' + p.name] || {}).version;
        if (dev[p.name] !== p.version || locked !== p.version) found.push(path.relative(REPO, file) + ': ' + p.name + '@' + p.version + ', package.json has ' + dev[p.name] + ', package-lock.json has ' + locked);
      }
    }
  }
  assert.ok(seen > 0, 'the scan finds the CDN links the room page loads');
  assert.deepStrictEqual(found, [], 'Put the same version in devDependencies and run npm install, so npm audit (.github/workflows/audit.yml) checks what the page runs.');
});
