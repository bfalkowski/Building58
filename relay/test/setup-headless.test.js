// setup.sh on a server with no screen: before the GitHub step it prints the ssh -L command for the
// laptop, the helper is told the port and not to open a browser, links are printed in place of opened,
// and the room's own tunnel is printed at the end.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const STUBS = {
  docker: '#!/bin/sh\n[ "$1 $2" = "compose logs" ] && echo "Repos: none"\nexit 0\n',
  curl: '#!/bin/sh\nexit 0\n',
  node: '#!/bin/sh\n[ "$1" = "-p" ] && { echo 20; exit 0; }\necho "NODE $*"\nexit 0\n',
  open: '#!/bin/sh\necho OPENED "$@"\n',
};

const PTY = [
  'import os, pty, sys',
  'pid, fd = pty.fork()',
  'if pid == 0:',
  '    os.execvp("sh", ["sh", "setup.sh"])',
  'os.write(fd, b"\\n" * 8)',
  'out = b""',
  'while True:',
  '    try:',
  '        chunk = os.read(fd, 4096)',
  '    except OSError:',
  '        break',
  '    if not chunk:',
  '        break',
  '    out += chunk',
  'os.waitpid(pid, 0)',
  'sys.stdout.buffer.write(out)',
].join('\n');

function run(headless, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  fs.copyFileSync(path.join(root, 'setup.sh'), path.join(dir, 'setup.sh'));
  fs.writeFileSync(path.join(dir, '.env'), 'RELAY_KEY=k\nCLAUDE_CODE_USE_BEDROCK=1\n' + (env || ''), { mode: 0o600 });
  const e = { PATH: bin + ':/usr/bin:/bin', HOME: dir, SETUP_HEADLESS: headless ? '1' : '0', SETUP_APP_PORT: '47123' };
  const r = spawnSync('python3', ['-I', '-c', PTY], { cwd: dir, env: e, encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return r.stdout + r.stderr;
}

test('with no display, it prints the ssh -L command and does not say a browser will open', () => {
  const out = run(true);
  assert.match(out, /ssh -N -L 47123:localhost:47123 \S+@\S+/);
  assert.doesNotMatch(out, /Your browser will open/);
});

test('with no display, the Node helper gets the port and --no-open', () => {
  assert.match(run(true), /NODE relay\/github-app\.js create --env \.env --port 47123 --no-open/);
});

test('with no display, it prints the room tunnel and the links, and opens nothing', () => {
  const out = run(true, 'GITHUB_APP_ID=1\nROOM_REPOS=a/b\n');
  assert.match(out, /run ssh -N -L 8787:localhost:8787 \S+@\S+ there/);
  assert.match(out, /Open this link in your browser: http:\/\/localhost:8787\/office\//);
  assert.doesNotMatch(out, /OPENED/);
});

test('github-app.js create --no-open prints the link and starts no opener', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const mark = path.join(dir, 'opened');
  for (const name of ['open', 'xdg-open']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\ntouch "' + mark + '"\n', { mode: 0o755 });
  const child = spawn(process.execPath, [path.join(root, 'relay', 'github-app.js'), 'create', '--env', path.join(dir, '.env'), '--port', '0', '--no-open'], { env: { PATH: bin + ':/usr/bin:/bin' } });
  return new Promise((resolve) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (/Opening /.test(out)) child.kill(); });
    child.on('close', () => {
      const opened = fs.existsSync(mark);
      fs.rmSync(dir, { recursive: true, force: true });
      assert.match(out, /Opening http:\/\/localhost:\d+\//);
      assert.match(out, /Open it in your browser/);
      assert.strictEqual(opened, false);
      resolve();
    });
  });
});

test('with a display, it prints no ssh command and opens the link', () => {
  const out = run(false, 'GITHUB_APP_ID=1\nROOM_REPOS=a/b\n');
  assert.doesNotMatch(out, /ssh -N -L/);
  assert.match(out, /OPENED http:\/\/localhost:8787\/office\//);
});
