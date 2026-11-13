#!/usr/bin/env node
// Records the trailer (office/trailer.js) to a smooth video: npm run trailer.
// It serves this folder on a local port, opens the room with ?trailer in Chrome with no window, and
// takes over the page's clock. Each step moves the clock on by exactly one frame, takes a picture and
// sends it to ffmpeg. A slow computer takes longer, but drops no frames.
//
//   npm run trailer                          trailer.mp4, 1920 x 1080 at 60 frames a second
//   npm run trailer -- --out film.mp4 --fps 30 --width 3840 --height 2160
//   npm run trailer -- --stills 5,16,47      only those seconds, as PNG pictures, to look at shots
//   npm run trailer -- --look live           the room lit live, without the baked look
//
// Needs ffmpeg on the PATH, and Chrome or the Chromium from npx playwright-core install chromium.
// Nothing leaves this computer except the page's own CDN and font links.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const FPS = Number(opt('fps', 60)), WIDTH = Number(opt('width', 1920)), HEIGHT = Number(opt('height', 1080));
const OUT = path.resolve(opt('out', 'trailer.mp4'));
const LOOK = opt('look', 'baked');
const STILLS = opt('stills', '') ? opt('stills').split(',').map(Number).sort((a, b) => a - b) : null;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml' };
function serve() {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, name.endsWith('/') ? name + 'index.html' : name);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launch() {
  const gl = ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'];
  try { return await chromium.launch({ channel: 'chrome', args: gl }); } catch (e) { return chromium.launch({ args: gl }); }
}

async function main() {
  const server = await serve();
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.clock.install({ time: new Date('2026-11-13T21:30:00') });
  const url = 'http://127.0.0.1:' + server.address().port + '/office/?trailer&look=' + encodeURIComponent(LOOK);
  await page.goto(url, { waitUntil: 'load' });
  // Let the room build and the baked look load, on the page's clock, until the film starts.
  for (let i = 0; ; i++) {
    const state = await page.evaluate(() => document.documentElement.dataset.trailer);
    if (state === 'playing') break;
    if (i > 1200) throw new Error('The trailer did not start. Is the page showing its fallback (no WebGL)?');
    await page.clock.runFor(50);
    await new Promise((r) => setTimeout(r, 20));  // real time for the model and textures to arrive
  }
  const length = await page.evaluate(() => window.trailer.length);
  const frames = Math.ceil(length * FPS);
  let ffmpeg = null;
  if (!STILLS) {
    ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] });
  }
  const started = Date.now();
  let shown = 0, next = 0;
  for (let f = 0; f < frames; f++) {
    const t = f / FPS;
    // the film's time is this frame's, and the page's clock moves on by one frame (in whole
    // milliseconds that add up exactly), so the room draws it
    await page.evaluate((v) => { window.trailer.clock = v; }, t);
    await page.clock.runFor(Math.round((f + 1) * 1000 / FPS) - Math.round(f * 1000 / FPS));
    if (STILLS) {
      if (next >= STILLS.length) break;
      if (t + 1e-6 >= STILLS[next]) {
        const file = OUT.replace(/\.mp4$/, '') + '-' + STILLS[next].toFixed(1) + 's.png';
        await page.screenshot({ path: file, type: 'png' }); console.log(file, JSON.stringify(await page.evaluate((d) => [window.trailer.t, window.trailer.shot].concat(d ? d.split(';').map((n) => [n, window.run.where(n), window.run.debug(n.replace('screen:', ''))]) : []), process.env.TRAILER_DEBUG || ''))); next++;
      }
    } else {
      const shot = await page.screenshot({ type: 'png' });
      if (!ffmpeg.stdin.write(shot)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
      if (Date.now() - shown > 5000) { shown = Date.now(); const s = (Date.now() - started) / 1000; console.log('frame ' + f + ' of ' + frames + ', ' + Math.round(s / (f + 1) * (frames - f - 1)) + ' s to go'); }
    }
  }
  if (ffmpeg) { ffmpeg.stdin.end(); await new Promise((r) => ffmpeg.on('close', r)); console.log('wrote ' + OUT); }
  await browser.close(); server.close();
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
