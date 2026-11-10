// Keeps the relay running across a restart. `node relay/server.js` starts here, and runs the relay
// itself as a child. When the relay exits with RESTART (the Update button, relay/update.js), this
// starts it again from the files on disk, on the same port with the same key. Any other exit ends
// this too, and Ctrl+C or a stop reaches the relay through here, so it can save its sessions first.
//
// While RELAY_TERMINAL=1 it also starts the session host (relay/session-host.js), which runs the
// sessions, and names its socket to each relay it starts. A restart leaves the host and its sessions
// running. When this stops, it stops the host after the relay, and the sessions end. If the host
// stops by itself, the relay restarts, and this starts a new host first.
//
// While RELAY_ROLLBACK=1, it checks each relay it starts, and goes back to the last commit that
// passed when the relay fails on an Update's new code (relay/rollback.js).
//
// It loads once and runs until you stop the relay, so a change here needs a stop and start by hand.
// Keep it small.
'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const rollback = require('./rollback.js');
const sessionHost = require('./session-host.js');

const RESTART = 75;

function supervise(file) {
  const env = Object.assign({}, process.env, { RELAY_WORKER: '1', RELAY_SUPERVISED: '1' });
  // A random key must stay the same across a restart, or open pages and session hooks lose the relay.
  if (!env.RELAY_KEY) { env.RELAY_KEY = crypto.randomBytes(12).toString('hex'); env.RELAY_KEY_RANDOM = '1'; }
  const guard = rollback.ON();
  let child = null, stopping = false, host = null;
  const hostGone = () => !host || host.child.exitCode !== null || host.child.signalCode !== null;
  // The sessions end after the relay, so the relay can save them first.
  const finish = (code) => { if (host) host.stop(() => process.exit(code)); else process.exit(code); };
  // newCode: this start followed an Update's restart. again: this start is a rollback.
  function run(newCode, again) {
    const commit = guard ? rollback.head() : null;
    if (env.RELAY_TERMINAL === '1' && hostGone()) { host = sessionHost.launch(); env.RELAY_HOST_SOCKET = host.socket; }
    // Its own process group, so Ctrl+C comes through here and the relay stops its sessions itself.
    const me = child = spawn(process.execPath, [file].concat(process.argv.slice(2)), { env, stdio: 'inherit', detached: true });
    let checking = guard, back = null;  // back: what to do once this relay has exited, after a failed check
    function failed(why) {
      checking = false;
      const p = rollback.plan({ newCode, again, good: rollback.read().commit, head: commit, dirty: rollback.changed() });
      console.error('\nThe relay on ' + String(commit).slice(0, 7) + ' failed its check: ' + why + '.' + (p.rollback ? '' : ' ' + p.why));
      if (!p.rollback) return;
      const good = rollback.read().commit;
      back = () => {
        // If git refuses, nothing in the folder changed, so the relay starts again on the same code,
        // as a rollback that never rolls back again, rather than leaving no relay at all.
        try { rollback.checkout(good); } catch (e) {
          console.error('Could not check out ' + good.slice(0, 7) + ', so the folder is as it was: ' + e.message + '. Starting the relay again on ' + String(commit).slice(0, 7) + '.');
          run(false, true); return;
        }
        rollback.noteRollback(commit, good, why);
        console.error('Rolled back to ' + good.slice(0, 7) + ', the last commit that passed. Starting the relay again.');
        run(false, true);
      };
      // The relay saves its sessions as it stops, and the exit below goes back.
      if (me.exitCode === null && me.signalCode === null) { me.kill('SIGTERM'); setTimeout(() => { if (me.exitCode === null && me.signalCode === null) me.kill('SIGKILL'); }, 10000).unref(); }
    }
    if (guard) {
      rollback.check({ port: env.PORT || 8787, key: env.RELAY_KEY, alive: () => me.exitCode === null && me.signalCode === null }).then((r) => {
        if (!checking || me !== child || stopping) return;
        if (r.ok) { checking = false; if (commit) rollback.passed(commit); console.log('The relay on ' + String(commit).slice(0, 7) + ' passed its check.'); return; }
        failed(r.why);
      });
    }
    me.on('exit', (code, signal) => {
      if (back && !stopping) { const go = back; back = null; go(); return; }
      if (code === RESTART && !stopping) { console.log('Starting the relay again.'); run(true, false); return; }
      if (checking && !stopping) {
        failed('it stopped' + (code !== null ? ' with exit code ' + code : ' on ' + signal));
        if (back) { const go = back; back = null; go(); return; }
      }
      if (!stopping) {
        console.error('\nThe relay stopped' + (code !== null ? ' with exit code ' + code : ' on ' + signal) + '. The lines above say why.');
        console.error('Its sessions are saved. Start it again (npm run office, or node relay/server.js) and they all come back.');
      }
      finish(code === null ? (signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1) : code);
    });
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stopping = true; if (child && child.exitCode === null) child.kill('SIGTERM'); });
  run(false, false);
}

module.exports = { supervise, RESTART };
