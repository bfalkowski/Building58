// Update's steps: while RELAY_ROLLBACK=1, Update takes main forward one merge at a time, not straight
// to the latest (relay/update.js). This lists the steps and keeps the loop in a file, since a step that
// changes relay files ends the relay, and the next relay carries the loop on once its check passes
// (relay/rollback.js). A record for another folder reads as none. resume is pure, so its rules are
// tested on their own. See docs/manual/running.html#update-steps.
'use strict';
const fs = require('fs');
const path = require('path');
const state = require('./state.js');
const tasks = require('./tasks.js');

const FILE = () => state.file('update-steps.json', 'RELAY_UPDATE_STEPS_FILE');
const LIMIT = () => Math.min(100, Math.max(1, Math.floor(Number(process.env.RELAY_UPDATE_STEPS)) || 20));
const STALE = 15 * 60 * 1000;

const prOf = (subject) => { const m = /^Merge pull request #(\d+)\b/.exec(subject || '') || /\(#(\d+)\)$/.exec(subject || ''); return m ? Number(m[1]) : null; };

async function list(dir, from, to) {
  if (from === to) return [];
  const out = await tasks.git(dir, ['log', '--first-parent', '--reverse', '--format=%H%x09%P%x09%s', from + '..' + to]);
  const commits = out.split('\n').filter(Boolean).map((line) => { const [sha, parents, ...rest] = line.split('\t'); return { sha, merge: parents.split(' ').length > 1, subject: rest.join('\t') }; });
  const steps = commits.filter((c) => c.merge).map((c) => ({ sha: c.sha, pr: prOf(c.subject), subject: c.subject }));
  if (!steps.length || steps[steps.length - 1].sha !== to) {
    const last = commits[commits.length - 1];
    steps.push({ sha: to, pr: prOf(last && last.subject), subject: last ? last.subject : '' });
  }
  return steps;
}
const name = (s) => (s.pr ? 'PR ' + s.pr : 'commit ' + s.sha.slice(0, 7));
const names = (list) => list.map(name).join(', ');

function read(dir) {
  try { const s = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return s && s.dir === dir && Array.isArray(s.steps) ? s : null; } catch (e) { return null; }
}
function write(loop) {
  const file = FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(loop, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function clear() { try { fs.unlinkSync(FILE()); return true; } catch (e) { return false; } }

function resume(loop, { loaded, back, now }) {
  if (!loop) return { go: 'none' };
  const step = loop.steps[loop.at];
  if (!step) return { go: 'drop', why: 'it had no step left' };
  if (now - Date.parse(loop.restartAt) > STALE) return { go: 'drop', why: 'its restart was more than 15 minutes ago, so this relay was started by hand' };
  if (back && back.failed === step.sha) return { go: 'failed', step, why: back.why };
  if (loaded === step.sha) return { go: 'check', step };
  return { go: 'drop', why: 'this relay runs ' + String(loaded).slice(0, 7) + ', not ' + step.sha.slice(0, 7) + ', the step it restarted for' };
}

module.exports = { FILE, LIMIT, STALE, list, prOf, name, names, read, write, clear, resume };
