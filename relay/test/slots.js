// Test slots: one pool that every npm test on this computer shares, so many runs at once do not
// swamp it (T-351). Each slot is a file, slot-<n>, in one folder under the system temp folder, made
// with an exclusive create and holding the pid of the run that has it. A run that finds every slot
// taken writes wait-<when it started>-<pid> and waits. When a slot frees, the run that started first
// takes it, so the runs end one after another instead of all late together. A run keeps its slot
// for its next file while no older run waits, so a younger run cannot take it in between.
// A run lets go of its slots when it ends, even on Ctrl-C. A slot or wait file whose pid is gone,
// from a run that was killed, is removed by the next run that finds it. The folder is watched, so a
// waiting run takes a slot as soon as one frees. A killed run leaves no event, so a waiting run also
// looks again every few seconds.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.tmpdir(), 'building58-test-slots');
const RECHECK_MS = 3000;

function alive(pid) {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
const pidIn = (file) => { try { return Number(fs.readFileSync(file, 'utf8')); } catch (e) { return 0; } };
const removeIfDead = (file) => { const pid = pidIn(file); if (pid && !alive(pid) && pidIn(file) === pid) { try { fs.unlinkSync(file); } catch (e) { /* another run removed it */ } } };

function slots({ dir = DIR, size, started = Date.now() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const me = String(process.pid);
  const waitName = 'wait-' + String(started).padStart(15, '0') + '-' + me;
  const waitFile = path.join(dir, waitName);
  const held = new Set();
  const waiters = [];
  let watcher = null, timer = null;

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
    if (!watcher) { watcher = fs.watch(dir, wake); watcher.on('error', () => {}); }
    if (!timer) timer = setInterval(wake, RECHECK_MS);
  };
  const close = () => { for (const n of [...held]) release(n); waiters.length = 0; stopWaiting(); };
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
  const olderWaiting = () => olderWaits().length > 0;
  return { take, close, olderWaiting };
}

module.exports = { slots, DIR };
