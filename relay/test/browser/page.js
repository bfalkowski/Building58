// The room page in a real browser, against a real relay with the fake claude and a throwaway home
// (relay/test/helpers.js). Run with npm run test:browser, after npx playwright-core install chromium.
//
// Nothing leaves this computer. three.js and xterm come from node_modules, at the same versions as the
// page's CDN links. The Google Fonts stylesheet is answered empty, so the page uses its fallback fonts.
// Any other outside request is refused and fails the test, so a new CDN link has to be added here.
//
// Most tests open the page with WebGL off, as on a computer without it: the scene shows its fallback
// and every panel still works. Building the scene in software takes 4 to 8 seconds a page, against a
// fifth of a second without it. Pass { webgl: true } for SwiftShader, Chrome's software renderer, so a
// runner with no GPU draws the scene the same way. No test reads what the scene draws.
//
// When a test fails, its screenshot and the page's console go to test-results/browser/, or to
// BROWSER_ARTIFACTS. The pipeline keeps that folder as an artifact.
'use strict';
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { chromium } = require('playwright-core');
const { relay, ROOT } = require('../helpers.js');

const MODULES = path.join(ROOT, 'node_modules');
const LOCAL = {
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js': 'three/build/three.min.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js': 'three/examples/js/controls/OrbitControls.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js': 'three/examples/js/loaders/GLTFLoader.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/shaders/CopyShader.js': 'three/examples/js/shaders/CopyShader.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/shaders/LuminosityHighPassShader.js': 'three/examples/js/shaders/LuminosityHighPassShader.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/EffectComposer.js': 'three/examples/js/postprocessing/EffectComposer.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/RenderPass.js': 'three/examples/js/postprocessing/RenderPass.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/ShaderPass.js': 'three/examples/js/postprocessing/ShaderPass.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/UnrealBloomPass.js': 'three/examples/js/postprocessing/UnrealBloomPass.js',
  'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js': '@xterm/xterm/lib/xterm.js',
  'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css': '@xterm/xterm/css/xterm.css',
  'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js'
};
const ARTIFACTS = path.resolve(process.env.BROWSER_ARTIFACTS || path.join(ROOT, 'test-results', 'browser'));
const SOFTWARE_GL = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const NO_GL = ['--disable-webgl', '--disable-3d-apis'];
// What three.js prints when there is no WebGL. The page expects it and shows its fallback.
const NO_GL_ERROR = 'THREE.WebGLRenderer: Error creating WebGL context.';
// In software a frame can take seconds on a CI runner, and longer while other test runs share the
// computer: one holiday test took 102 s there. So a page drawn in software gets two minutes for each
// wait and page load, and a test that uses one passes SOFTWARE, five minutes, to pageTest. That is
// past the 120 s relay/test/run.js gives every test.
const SLOW = 120000, SOFTWARE = { timeout: 300000 };

// Starts a relay and a browser. Each test gets a fresh page from page(). stop() ends both.
async function office(options) {
  const o = options || {};
  const R = await relay(o.env);
  let browser;
  try { browser = await chromium.launch({ args: o.webgl ? SOFTWARE_GL : NO_GL }); } catch (e) { await R.stop(); throw e; }
  const address = 'http://127.0.0.1:' + R.port + '/office/?channel=t&key=test-key';
  // A page, with every console message and error it printed, and every outside request it tried.
  async function page() {
    const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const p = await context.newPage();
    if (o.webgl) { p.setDefaultTimeout(SLOW); p.setDefaultNavigationTimeout(SLOW); }
    const log = [], errors = [];
    const note = (line, bad) => { log.push(new Date().toISOString().slice(11, 23) + ' ' + line); if (bad && !(!o.webgl && line.startsWith('error: ' + NO_GL_ERROR))) errors.push(line); };
    context.on('page', (other) => { if (other !== p) other.on('pageerror', (e) => note('pageerror in ' + other.url() + ': ' + e.message, true)); });
    p.on('console', (m) => note(m.type() + ': ' + m.text() + (m.type() === 'error' && m.location().url ? ' (' + m.location().url + ')' : ''), m.type() === 'error'));
    p.on('pageerror', (e) => note('pageerror: ' + (e.stack || e.message), true));
    await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => {
      const u = route.request().url();
      if (LOCAL[u]) return route.fulfill({ path: path.join(MODULES, LOCAL[u]) });
      if (u.startsWith('https://fonts.googleapis.com/')) return route.fulfill({ contentType: 'text/css', body: '' });
      note('outside request refused: ' + u, true);
      return route.abort();
    });
    return { page: p, context, log, errors, open: () => p.goto(address).then(() => ready(p)) };
  }
  const stop = async () => { await browser.close().catch(() => {}); await R.stop(); };
  return { R, browser, page, address, stop };
}

// The page is ready once it is connected to the relay and the Claude Code panel has read the sessions.
async function ready(p) {
  await p.locator('#relay-status[data-state="on"]').waitFor();
  await p.waitForFunction(() => !/^Starting/.test(document.getElementById('cc-status').textContent));
}

// One test with its own page. A failure saves a screenshot and the console before the page closes.
// options go to node's test(), like SOFTWARE.
function pageTest(name, getOffice, fn, options) {
  test(name, options || {}, async () => {
    const o = getOffice();
    const p = await o.page();
    try { await fn(p); } catch (e) {
      const base = path.join(ARTIFACTS, name.replace(/[^\w-]+/g, '-').slice(0, 80));
      fs.mkdirSync(ARTIFACTS, { recursive: true });
      await p.page.screenshot({ path: base + '.png', fullPage: true }).catch(() => {});
      fs.writeFileSync(base + '.console.txt', p.log.join('\n') + '\n\n# relay\n' + o.R.output());
      throw e;
    } finally { await p.context.close().catch(() => {}); }
  });
}

// The page's errors, less Chrome's line for one answer a test caused on purpose, like a 409 from a route.
const errorsBut = (p, status, route) => p.errors.filter((e) => !(e.startsWith('error: Failed to load resource: the server responded with a status of ' + status + ' ') && pathOf(e) === route));
const pathOf = (line) => { const m = line.match(/\((http[^)]+)\)$/); return m ? new URL(m[1]).pathname : null; };  // a line with no address is kept, as an error
// Waits until fn, run in the page, returns something true. Arguments go to fn.
const until = (p, fn, arg) => p.page.waitForFunction(fn, arg);
// The text of the Claude Code terminal, as xterm drew it.
const screenText = (p) => p.page.locator('#cc-term .xterm-rows').innerText();

module.exports = { office, pageTest, SOFTWARE, until, screenText, errorsBut };
