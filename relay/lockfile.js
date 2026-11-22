// Each relay reads its files once and writes them whole, so two relays on one file would erase
// each other's work. The first to claim a file owns it; a claim by a dead relay does not count.
//
// A claim holds the relay's pid. A relay that is killed leaves its claims, and the pid can be another
// process by the time the next relay starts: after a reboot, or in a new container, which numbers its
// processes from 1 again. So a claim counts only while its pid is still a relay (relay/server.js), read
// from /proc/<pid>/cmdline, or from ps where there is no /proc. If neither can say, it counts.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RELAY = /relay[\\/]server\.js/;
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function isRelay(pid) {
  if (fs.existsSync('/proc/self')) {
    try { return RELAY.test(fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8')); } catch (e) { return e.code !== 'ENOENT'; }
  }
  try { return RELAY.test(execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 })); } catch (e) { return e.status !== 1; }
}
function claim(file) {
  const lock = file + '.lock';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let tries = 0; tries < 2; tries++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      process.on('exit', () => { try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); } catch (e) { /* already gone */ } });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') { console.error('Could not claim ' + file + ': ' + e.message); return true; }
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      if (pid === process.pid) return true;
      if (pid && alive(pid) && isRelay(pid)) { console.error('Another relay (pid ' + pid + ') owns ' + file + '. This one will not save to it.'); return false; }
      try { fs.unlinkSync(lock); } catch (e2) { /* someone else got there */ }
    }
  }
  return false;
}
module.exports = { claim, isRelay };
