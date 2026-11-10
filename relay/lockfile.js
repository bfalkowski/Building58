// Each relay reads its files once and writes them whole, so two relays on one file would erase
// each other's work. The first to claim a file owns it; a claim by a dead relay does not count.
'use strict';
const fs = require('fs');
const path = require('path');

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
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
      if (pid && alive(pid)) { console.error('Another relay (pid ' + pid + ') owns ' + file + '. This one will not save to it.'); return false; }
      try { fs.unlinkSync(lock); } catch (e2) { /* someone else got there */ }
    }
  }
  return false;
}
module.exports = { claim };
