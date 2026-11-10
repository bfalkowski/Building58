// Where the relay keeps its state: one folder, ~/.office-world unless RELAY_STATE_DIR names another.
// A second room on the same computer needs only its own port and its own folder. A file's own
// variable, such as RELAY_TICKETS_FILE, still wins over the folder.
'use strict';
const os = require('os');
const path = require('path');

const home = (p) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
function dir() {
  const given = process.env.RELAY_STATE_DIR;
  return given ? path.resolve(home(given)) : path.join(os.homedir(), '.office-world');
}
// The file's own variable, or the file by that name in the folder.
function file(name, variable) {
  return (variable && process.env[variable]) || path.join(dir(), name);
}
// A path to show a session: under your home folder it starts with ~.
function shown(p) {
  const h = os.homedir();
  return p === h || p.startsWith(h + path.sep) ? '~' + p.slice(h.length) : p;
}
module.exports = { dir, file, shown };
