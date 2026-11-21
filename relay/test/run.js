#!/usr/bin/env node
// Runs every test file, or only the files named after it, several at once. Most tests start a relay
// and wait on its timers, so they wait far more than they compute. node --test alone runs one file
// fewer than the cores at a time, which is one at a time on CI's two cores, and the suite took 10
// minutes there. TEST_JOBS sets how many run at once (6). Each file's output is printed whole once it ends.
// Node 18 refuses --test-timeout, which arrived in 20.11 and 21.2. That limit ends a test, not the file:
// a relay or other child that no cleanup stopped keeps the file running after its last test. So each
// file also has a time limit of its own, TEST_FILE_SECONDS (600). A file still running then is stopped
// with everything it started, and fails with a message that says so, and the run goes on (T-184).
// Each file runs as node <file>, not under node --test, so the file's own process is the child here.
// node --test waits for every process that holds its child's output, so a file that left one running
// in a group of its own (as the session host is) never ended, and its time limit stopped only the
// group. Now a file whose process has ended, but whose output something still holds after
// HELD_SECONDS (5), fails with a message that says so, and the run goes on (T-170).
// Each file runs with its own empty HOME, removed when it ends, and without the room settings of
// the session that runs the tests (OFFICE_*, RELAY_*, CLAUDE_CODE_*, PORT, HOST). Some tests load relay modules in their
// own process, and those keep their files under ~/.office-world, so with your HOME they would read
// your room's files and fight every other checkout that runs the tests at the same time.
// Every run on this computer shares TEST_SLOTS test slots, one for each core by default, so at most that many files run at once
// across all checkouts (relay/test/slots.js). Four Devs once ran the suite together, 24 files at a time,
// and the runs took 20 minutes instead of 6, with files failing on the slow machine (T-351). A run
// that must wait says so once, and when slots free, the run that started first goes first. TEST_SLOTS=0
// turns the limit off, and a value that is not a whole number counts as the default. Test files of
// other repos that sessions of the room run take the same slots, through relay/test/slot-gate.js. Each file runs with
// TEST_SLOTS=0, so a run inside a test never waits behind its own parent. TEST_SLOTS_DIR moves the slots' folder, for the runner's own tests.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { slots, sizeOf, DIR } = require('./slots.js');
const { withoutRoom } = require('./helpers.js');

const [major, minor] = process.versions.node.split('.').map(Number);
const timeout = major > 21 || (major === 21 && minor >= 2) || (major === 20 && minor >= 11) ? ['--test-timeout=120000'] : [];
const asked = process.argv.slice(2);
// A folder named here stands for its .test.js files, so a script needs no shell glob (cmd on Windows has none).
const inFolder = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f));
const files = asked.length ? asked.map((f) => path.resolve(f)).flatMap((f) => (fs.statSync(f).isDirectory() ? inFolder(f) : [f])) : inFolder(__dirname);
const JOBS = Math.max(1, Number(process.env.TEST_JOBS) || 6);
const LIMIT = Math.max(1, Number(process.env.TEST_FILE_SECONDS) || 600);
const HELD_SECONDS = 5;
const SLOTS = sizeOf(process.env.TEST_SLOTS);
const pool = SLOTS ? slots({ dir: process.env.TEST_SLOTS_DIR || undefined, size: SLOTS }) : null;
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
    const env = Object.fromEntries(Object.entries(withoutRoom(process.env)).filter(([k]) => !['PORT', 'HOST', 'NODE_TEST_CONTEXT'].includes(k)));
    // Its own process group, so a file that runs out of time is stopped with every process it started.
    // Those hold its output open, and the file is not over until they let go. Windows has no groups.
    const group = process.platform !== 'win32';
    const child = spawn(process.execPath, [...timeout, file], { env: { ...env, HOME: home, PLAYWRIGHT_BROWSERS_PATH: BROWSERS, TEST_SLOTS: '0' }, stdio: ['ignore', 'pipe', 'pipe'], detached: group });
    if (group) running.add(child.pid);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    let late = false, held = false, wait = null, over = false;
    const stopAll = () => { try { if (group) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch (e) { /* already gone */ } };
    const limit = setTimeout(() => { late = true; stopAll(); }, LIMIT * 1000);
    const end = (code) => {
      if (over) return;
      over = true; clearTimeout(limit); clearTimeout(wait); running.delete(child.pid);
      if (late) out += '\n' + path.basename(file) + ' did not end within ' + LIMIT + ' seconds, so it was stopped. A test may have left a relay or other process running.\n';
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      resolve({ file, ok: code === 0 && !late && !held, out, seconds: Math.round((Date.now() - started) / 1000) });
    };
    child.on('exit', (code) => {
      wait = setTimeout(() => {
        held = true;
        out += '\n' + path.basename(file) + ' ended, but a process it started still held its output ' + HELD_SECONDS + ' seconds later, so the file failed. A test may have left a relay, session host or other process running in a group of its own.\n';
        stopAll(); child.stdout.destroy(); child.stderr.destroy(); end(code);
      }, HELD_SECONDS * 1000);
    });
    child.on('close', (code) => end(code));
  });
}

(async () => {
  const queue = files.slice(), failed = [];
  let told = false;
  const tell = () => {
    if (told) return;
    told = true;
    process.stdout.write('# waiting for a test slot: other runs on this computer hold all ' + SLOTS + ' slots (TEST_SLOTS), or started first and wait too. The slots are files in ' + (process.env.TEST_SLOTS_DIR || DIR) + '\n');
  };
  const slot = () => (pool ? pool.take(tell) : Promise.resolve(() => {}));
  const worker = async () => {
    let release = null;
    for (let file = queue.shift(); file; file = queue.shift()) {
      if (!release) release = await slot();
      const r = await runOne(file);
      process.stdout.write('\n# ' + path.basename(r.file) + ' (' + r.seconds + 's, ' + (r.ok ? 'pass' : 'FAIL') + ')\n' + r.out);
      if (!r.ok) failed.push(path.basename(r.file));
      if (!queue.length || (pool && pool.olderWaiting())) { release(); release = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(JOBS, files.length) }, worker));
  console.log('\n# ' + files.length + ' test files, ' + (files.length - failed.length) + ' passed' + (failed.length ? ', failed: ' + failed.join(', ') : ''));
  process.exitCode = failed.length ? 1 : 0;
})();
