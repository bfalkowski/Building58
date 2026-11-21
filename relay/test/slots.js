// Test slots: one pool that every npm test on this computer shares, so many runs at once do not
// swamp it (T-351). Each slot is a file, slot-<n>, in one folder under the system temp folder, made
// with an exclusive create and holding the pid of the run that has it. A run that finds every slot
// taken writes wait-<when it started>-<pid> and waits. When a slot frees, the run that started first
// takes it, so the runs end one after another instead of all late together. A run keeps its slot
// for its next file while no older run waits, so a younger run cannot take it in between.
// A run lets go of its slots when it ends, even on Ctrl-C. A run touches its own slot and wait files
// every few seconds. A file whose pid is gone, or that nobody touched for STALE_MS, is from a run that
// was killed, and the next run that finds it removes it. The time catches a pid that another process
// took after the run died, which would otherwise look alive and block every younger run. The folder is watched, so a
// waiting run takes a slot as soon as one frees. A killed run leaves no event, so a waiting run also
// looks again every few seconds.
// takeSync waits by blocking instead, for relay/test/slot-gate.js, which must hold a slot before the
// test file it runs in loads. sizeOf turns TEST_SLOTS into the pool's size: a whole number, 0 for no
// limit, and otherwise the number of cores, so the files that run at once match what the computer has.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.tmpdir(), 'building58-test-slots');
const RECHECK_MS = 3000;
const STALE_MS = 30000;
const sizeOf = (value) => (/^\d+$/.test(value || '') ? Number(value) : (os.availableParallelism ? os.availableParallelism() : os.cpus().length));

function alive(pid) {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
const pidIn = (file) => { try { return Number(fs.readFileSync(file, 'utf8')); } catch (e) { return 0; } };
const touchedAt = (file) => { try { return fs.statSync(file).mtimeMs; } catch (e) { return Date.now(); } };
const removeIfDead = (file) => {
  const pid = pidIn(file);
  if (!pid || (alive(pid) && Date.now() - touchedAt(file) < STALE_MS)) return;
  if (pidIn(file) === pid) { try { fs.unlinkSync(file); } catch (e) { /* another run removed it */ } }
};

function slots({ dir = DIR, size, started = Date.now() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const me = String(process.pid);
  const waitName = 'wait-' + String(started).padStart(15, '0') + '-' + me;
  const waitFile = path.join(dir, waitName);
  const held = new Set();
  const waiters = [];
  let watcher = null, timer = null, waiting = false;
  const touch = (file) => { const now = new Date(); try { fs.utimesSync(file, now, now); } catch (e) { /* removed */ } };
  const heartbeat = setInterval(() => {
    for (const n of held) touch(path.join(dir, 'slot-' + n));
    if (waiting) touch(waitFile);
  }, RECHECK_MS);
  heartbeat.unref();

  const olderWaits = () => fs.readdirSync(dir).filter((f) => f.startsWith('wait-') && f < waitName).filter((f) => {
    removeIfDead(path.join(dir, f));
    return fs.existsSync(path.join(dir, f));
  });
  const grab = () => {
    if (olderWaits().length) return -1;
    for (let n = 0; n < size; n++) {
      const file = path.join(dir, 'slot-' + n);
      removeIfDead(file);
      try { fs.writeFileSync(file, me, { flag: 'wx' }); held.add(n); return n; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    return -1;
  };
  const release = (n) => {
    if (!held.delete(n)) return;
    const file = path.join(dir, 'slot-' + n);
    if (pidIn(file) === process.pid) { try { fs.unlinkSync(file); } catch (e) { /* already gone */ } }
  };
  const stopWaiting = () => {
    if (watcher) { watcher.close(); watcher = null; }
    if (timer) { clearInterval(timer); timer = null; }
    waiting = false;
    try { fs.unlinkSync(waitFile); } catch (e) { /* not there */ }
  };
  const wake = () => {
    while (waiters.length) {
      const n = grab();
      if (n < 0) return;
      waiters.shift()(() => release(n));
    }
    stopWaiting();
  };
  const startWaiting = () => {
    fs.writeFileSync(waitFile, me);
    waiting = true;
    if (!watcher) { watcher = fs.watch(dir, wake); watcher.on('error', () => {}); }
    if (!timer) timer = setInterval(wake, RECHECK_MS);
  };
  const close = () => { for (const n of [...held]) release(n); waiters.length = 0; stopWaiting(); clearInterval(heartbeat); };
  process.on('exit', close);

  const take = (onWait) => {
    if (!waiters.length) {
      const n = grab();
      if (n >= 0) return Promise.resolve(() => release(n));
    }
    startWaiting();
    if (onWait) onWait();
    return new Promise((resolve) => { waiters.push(resolve); });
  };
  const takeSync = (onWait) => {
    let n = grab();
    if (n < 0) {
      fs.writeFileSync(waitFile, me);
      waiting = true;
      if (onWait) onWait();
      const cell = new Int32Array(new SharedArrayBuffer(4));
      let touched = Date.now();
      while (n < 0) {
        Atomics.wait(cell, 0, 0, 200);
        if (Date.now() - touched >= RECHECK_MS) { touch(waitFile); touched = Date.now(); }
        n = grab();
      }
      waiting = false;
      try { fs.unlinkSync(waitFile); } catch (e) { /* not there */ }
    }
    return () => release(n);
  };
  const olderWaiting = () => olderWaits().length > 0;
  return { take, takeSync, close, olderWaiting };
}

module.exports = { slots, sizeOf, DIR, STALE_MS };
