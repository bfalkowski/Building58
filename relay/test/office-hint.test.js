'use strict';
// What npm run office prints about the hooks (T-191). It runs the real relay/office.js against a
// stand-in relay that says a room page is on screen, so the script prints its hint and exits.
// The default room is told how to add the hooks, without the key. A second room is told not to.
// When no page is on screen, the link it prints has a placeholder, and only the browser gets the key.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { execFile } = require('child_process');
const { ROOT } = require('./helpers.js');
const { hookHint, isDefaultOffice } = require('../office-hint.js');

const KEY = 'hint-test-key-' + process.pid;
const DEFAULT_DIR = path.join(os.homedir(), '.office-world');

// A relay that answers /health and says a page is on screen on every channel.
function standIn() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/health' ? { ok: true } : { ok: true, pagesVisible: 1 }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
function runOffice(env) {
  return new Promise((resolve) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(RELAY_|OFFICE_|CHANNEL$)/.test(k)));
    execFile(process.execPath, [path.join(ROOT, 'relay', 'office.js')], { env: Object.assign(clean, { RELAY_KEY: KEY, OPEN_CMD: 'true' }, env), timeout: 20000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr }));
  });
}

test('a second room on another port is told not to add the hooks, and its key is not printed', async (t) => {
  const server = await standIn();
  t.after(() => server.close());
  const r = await runOffice({ RELAY_URL: 'http://127.0.0.1:' + server.address().port });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /This is a second room/);
  assert.match(r.out, /Do not install/);
  assert.doesNotMatch(r.out, /--install/);
  assert.ok(!r.out.includes(KEY), 'the key was printed:\n' + r.out);
});

test('a second room with its own state folder is told not to add the hooks', () => {
  const hint = hookHint('http://localhost:8787', path.join(os.tmpdir(), 'office-b'), 'office');
  assert.match(hint, /This is a second room/);
  assert.doesNotMatch(hint, /--install/);
});

test('the default room is told how to add the hooks, with a placeholder for the key', () => {
  for (const url of ['http://localhost:8787', 'http://127.0.0.1:8787']) {
    assert.ok(isDefaultOffice(url, DEFAULT_DIR), url);
    const hint = hookHint(url, DEFAULT_DIR, 'office');
    assert.match(hint, /OFFICE_RELAY_KEY=<your relay key> node relay\/office-hook\.js --install/);
  }
  assert.match(hookHint('http://localhost:8787', DEFAULT_DIR, 'my project'), /office-hook\.js --install --channel 'my project'$/);
  assert.ok(!isDefaultOffice('http://localhost:8790', DEFAULT_DIR));
  assert.ok(!isDefaultOffice('http://example.com:8787', DEFAULT_DIR));
});

test('with no room page on screen, the printed link has a placeholder, and only the browser gets the key', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-open-'));
  const opened = path.join(dir, 'opened.txt');
  const opener = path.join(dir, 'open.sh');
  fs.writeFileSync(opener, '#!/bin/sh\nprintf %s "$1" > "' + opened + '"\n', { mode: 0o755 });
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/health' ? { ok: true } : { ok: true, pagesVisible: fs.existsSync(opened) ? 1 : 0 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const r = await runOffice({ RELAY_URL: 'http://127.0.0.1:' + server.address().port, OPEN_CMD: opener });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /Opening the office: http:\/\/127\.0\.0\.1:\d+\/office\/\?channel=office&key=<your relay key>/);
  assert.ok(!r.out.includes(KEY), 'the key was printed:\n' + r.out);
  assert.match(fs.readFileSync(opened, 'utf8'), new RegExp('&key=' + KEY + '$'), 'the browser was not given the key');
});

// The room's name on the link npm run office opens and prints (T-304). OPEN_CMD is a fake opener
// that writes the link it was given to a file.
function openedLink(env) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-name-'));
    const opener = path.join(dir, 'open.js');
    const out = path.join(dir, 'link.txt');
    fs.writeFileSync(opener, '#!/usr/bin/env node\nrequire("fs").writeFileSync(' + JSON.stringify(out) + ', process.argv[2]);\n', { mode: 0o755 });
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/health' ? { ok: true } : { ok: true, pagesVisible: /\/channels\/(.*)/.test(req.url) && fs.existsSync(out) ? 1 : 0 }));
    });
    server.listen(0, '127.0.0.1', () => {
      runOffice(Object.assign({ RELAY_URL: 'http://127.0.0.1:' + server.address().port, OPEN_CMD: opener }, env)).then((r) => {
        server.close();
        resolve({ r, link: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null });
      });
    });
  });
}

test('RELAY_ROOM_NAME puts the encoded name in the opened and printed link, and nothing else', async () => {
  const name = 'Room C & D #1 é日本';
  const { r, link } = await openedLink({ RELAY_ROOM_NAME: '  ' + name + '\n', RELAY_OTHER_VALUE: 'zzz-value' });
  assert.strictEqual(r.code, 0, r.out);
  const url = new URL(link);
  assert.strictEqual(url.searchParams.get('name'), name);
  assert.strictEqual(url.searchParams.get('key'), KEY);
  assert.ok(r.out.includes('&name=' + encodeURIComponent(name)), r.out);
  assert.ok(!link.includes('zzz-value') && !r.out.includes('zzz-value'));
  assert.deepStrictEqual([...url.searchParams.keys()], ['channel', 'key', 'name']);
});

test('RELAY_ROOM_NAME is cut to 40 characters', async () => {
  const { link } = await openedLink({ RELAY_ROOM_NAME: 'x'.repeat(60) });
  assert.strictEqual(new URL(link).searchParams.get('name'), 'x'.repeat(40));
});

test('with no RELAY_ROOM_NAME the link has no name', async () => {
  const { r, link } = await openedLink({});
  assert.ok(link && !link.includes('name='), link);
  assert.ok(!r.out.includes('name='), r.out);
});
