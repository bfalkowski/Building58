// Says in #office when the default branch on origin moves. Every RELAY_MAIN_POLL_SECONDS it asks
// origin where its HEAD points, with git ls-remote in the relay's folder, the one Update pulls into
// (relay/update.js). That changes nothing in the folder, not even its remote branches.
// The first answer is where this relay starts from, so it is not news, even if main moved while no
// relay ran. Each later answer that differs is one post. Other branches are not watched.
// See docs/manual/roles.html#chat.
'use strict';
const config = require('./config.js');
const tasks = require('./tasks.js');
const chat = require('./chat.js');
const { DIR } = require('./update.js');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Nothing may ask for a password or a passphrase: git's own prompt is off, and ssh runs in batch
// mode, so a look that needs one fails at once rather than waiting out its time limit. An ssh the
// person chose, in GIT_SSH_COMMAND, GIT_SSH or core.sshCommand, is left as it is. It is read at each
// look, so a change to core.sshCommand applies without a restart.
async function askOptions() {
  const env = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' });
  const chosen = env.GIT_SSH_COMMAND || env.GIT_SSH || await tasks.git(DIR, ['config', 'core.sshCommand']).catch(() => '');
  if (!chosen) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return { timeout: 15000, env };
}

// Where origin's default branch points: { branch, sha }, or { error } when origin cannot be asked.
async function originHead() {
  let out;
  try { out = await tasks.git(DIR, ['ls-remote', '--symref', 'origin', 'HEAD'], await askOptions()); } catch (e) { return { error: e.message }; }
  const ref = out.match(/^ref: refs\/heads\/(\S+)\tHEAD$/m), sha = out.match(/^([0-9a-f]{40,64})\tHEAD$/m);
  return ref && sha ? { branch: ref[1], sha: sha[1] } : { error: 'origin did not say which branch its HEAD is' };
}

let seen = null, looking = false, failing = false;
async function look() {
  if (looking) return;
  looking = true;
  try {
    const now = await originHead();
    // Origin did not answer: the next look tries again, and compares with what was last seen. The log
    // says so once, and once more when origin answers again, so the person can tell the watch is stuck.
    if (now.error) {
      if (!failing) log('Cannot learn from origin where its default branch points, so #office will not say when it moves. Trying again every ' + config.get('mainPollSeconds') + ' seconds. git said: ' + now.error.split('\n')[0]);
      failing = true;
      return;
    }
    if (failing) log('Origin answers again.');
    failing = false;
    const was = seen;
    seen = now;
    // A new default branch is a new place to start from, not a move of main.
    if (!was || was.branch !== now.branch) { log('Watching ' + now.branch + ' on origin at ' + now.sha.slice(0, 7) + '.'); return; }
    if (was.sha !== now.sha) chat.announceAll(now.branch + ' moved on origin, from ' + was.sha.slice(0, 7) + ' to ' + now.sha.slice(0, 7) + '.');
  } finally { looking = false; }
}
config.every('mainPollSeconds', look, 5000);  // 0 stops it

module.exports = { look };
