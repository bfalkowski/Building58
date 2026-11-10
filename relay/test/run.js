#!/usr/bin/env node
// Runs every test file, or only the files named after it, several at once. Most tests start a relay
// and wait on its timers, so they wait far more than they compute. node --test alone runs one file
// fewer than the cores at a time, which is one at a time on CI's two cores, and the suite took 10
// minutes there. TEST_JOBS sets how many run at once (6). Each file's output is printed whole once it ends.
// Node 18 refuses --test-timeout, which arrived in 20.11 and 21.2. That limit ends a test, not the file:
// a relay or other child that no cleanup stopped keeps the file running after its last test. So each
// file also has a time limit of its own, TEST_FILE_SECONDS (600). A file still running then is stopped
// with everything it started, and fails with a message that says so, and the run goes on (T-184).
// Each file runs with its own empty HOME, removed when it ends, and without the room settings of
// the session that runs the tests (OFFICE_*, RELAY_*, PORT, HOST). Some tests load relay modules in their
// own process, and those keep their files under ~/.office-world, so with your HOME they would read
// your room's files and fight every other checkout that runs the tests at the same time.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const [major, minor] = process.versions.node.split('.').map(Number);
const timeout = major > 21 || (major === 21 && minor >= 2) || (major === 20 && minor >= 11) ? ['--test-timeout=120000'] : [];
const asked = process.argv.slice(2);
// A folder named here stands for its .test.js files, so a script needs no shell glob (cmd on Windows has none).
const inFolder = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f));
const files = asked.length ? asked.map((f) => path.resolve(f)).flatMap((f) => (fs.statSync(f).isDirectory() ? inFolder(f) : [f])) : inFolder(__dirname);
const JOBS = Math.max(1, Number(process.env.TEST_JOBS) || 6);
const LIMIT = Math.max(1, Number(process.env.TEST_FILE_SECONDS) || 600);
// Playwright looks for its browser under HOME, so the browser tests are told where it is under yours.
const CACHE = { darwin: path.join(os.homedir(), 'Library', 'Caches'), win32: process.env.LOCALAPPDATA }[process.platform] || process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
const BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(CACHE || os.homedir(), 'ms-playwright');

// A file in its own group does not get the terminal's Ctrl-C, so the run passes it on, and ends.
const running = new Set();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const pid of running) { try { process.kill(-pid, 'SIGKILL'); } catch (e) { /* already gone */ } }
    process.exit(130);
  });
}

function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = '';
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-home-')));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OFFICE_|RELAY_)/.test(k) && k !== 'PORT' && k !== 'HOST'));
    // Its own process group, so a file that runs out of time is stopped with every process it started.
    // Those hold its output open, and the file is not over until they let go. Windows has no groups.
    const group = process.platform !== 'win32';
    const child = spawn(process.execPath, ['--test', ...timeout, file], { env: { ...env, HOME: home, PLAYWRIGHT_BROWSERS_PATH: BROWSERS }, stdio: ['ignore', 'pipe', 'pipe'], detached: group });
    if (group) running.add(child.pid);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    let late = false;
    const limit = setTimeout(() => {
      late = true;
      try { if (group) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch (e) { /* already gone */ }
    }, LIMIT * 1000);
    child.on('close', (code) => {
      clearTimeout(limit); running.delete(child.pid);
      if (late) out += '\n' + path.basename(file) + ' did not end within ' + LIMIT + ' seconds, so it was stopped. A test may have left a relay or other process running.\n';
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      resolve({ file, ok: code === 0 && !late, out, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

(async () => {
  const queue = files.slice(), failed = [];
  const worker = async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const r = await runOne(file);
      process.stdout.write('\n# ' + path.basename(r.file) + ' (' + r.seconds + 's, ' + (r.ok ? 'pass' : 'FAIL') + ')\n' + r.out);
      if (!r.ok) failed.push(path.basename(r.file));
    }
  };
  await Promise.all(Array.from({ length: Math.min(JOBS, files.length) }, worker));
  console.log('\n# ' + files.length + ' test files, ' + (files.length - failed.length) + ' passed' + (failed.length ? ', failed: ' + failed.join(', ') : ''));
  process.exitCode = failed.length ? 1 : 0;
})();
