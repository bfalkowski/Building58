'use strict';
// A reviewer whose verdict was saved with its comment ends once a restart takes its session back, even
// when the saved session lacks the post.
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const { relay, makeRepo, until, sessionToken } = require('./helpers.js');

const RESUME = { RELAY_RESUME: '1', RELAY_WIP_LIMIT: '5' };
const PR = 'https://github.com/acme/widgets/pull/7';
const URL = PR + '#issuecomment-42';
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, file, text, message) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  sh(cwd, 'add', file);
  sh(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message);
};
const read = (home, name) => { try { return JSON.parse(fs.readFileSync(path.join(home, '.office-world', name), 'utf8')); } catch (e) { return null; } };

test('a reviewer with its review posted ends after a restart', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-test-')));
  const origin = path.join(home, 'origin.git'), src = path.join(home, 'src'), dir = path.join(home, 'relay-folder'), repo = path.join(home, 'repo'), prs = path.join(home, 'prs.git');
  makeRepo(home, 'src'); commit(src, 'relay/x.js', '1\n', 'relay file');
  sh(home, 'clone', '-q', '--bare', src, origin); sh(home, 'clone', '-q', origin, dir); sh(src, 'remote', 'add', 'origin', origin);
  makeRepo(home, 'repo');
  sh(home, 'init', '-q', '--bare', prs);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[url "' + prs + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', prs, 'HEAD:refs/pull/7/head');
  const R = await relay(Object.assign({ RELAY_UPDATE_DIR: dir, RELAY_REVIEW_GRACE_MS: '1500' }, RESUME), home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const hook = (s, extra) => R.hook(Object.assign({ session_id: s.sessionId.slice(0, 12) }, extra));

  const c = (await R.call('POST', '/checkouts', { from: repo, pr: PR, prompt: 'Review it.' })).body;
  assert.ok(c.id, JSON.stringify(c));
  await hook(c, { hook_event_name: 'UserPromptSubmit' });
  const token = { 'X-Office-Token': await until(() => { try { return sessionToken(c.sessionId); } catch (e) { return null; } }, 'its token') };
  await R.call('POST', '/autopilot/verdict', { kind: 'merge' }, token);
  await hook(c, { hook_event_name: 'Stop' });
  const f = path.join(home, '.office-world', 'autopilot.json'), store = read(home, 'autopilot.json');
  const verdict = store.t.prs[PR].verdicts.find((x) => x.sessionId === c.sessionId);
  assert.ok(verdict && !verdict.posted);
  verdict.posted = URL;
  fs.writeFileSync(f, JSON.stringify(store));
  const run = (await R.call('GET', '/update')).body.run;
  commit(src, 'relay/x.js', '2\n', 'relay change'); sh(src, 'push', '-q', 'origin', 'main');
  await R.call('POST', '/update', {});
  await until(async () => { try { return (await R.call('GET', '/update')).body.run !== run; } catch (e) { return false; } }, 'the relay to restart');
  await until(async () => !(await terminals()).some((x) => x.id === c.id), 'the reviewer to end');
});

test('a posted review is saved with its session at once, and a later prompt of the person clears it', async (t) => {
  const R = await relay({ RELAY_RESUME: '1', RELAY_REVIEW_GRACE_MS: '60000' }), repo = makeRepo(R.home), prs = path.join(R.home, 'prs.git');
  t.after(R.stop);
  sh(R.home, 'init', '-q', '--bare', prs);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + prs + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', prs, 'HEAD:refs/pull/7/head');
  const c = (await R.call('POST', '/checkouts', { from: repo, pr: PR, prompt: 'Review it.' })).body;
  assert.ok(c.id, JSON.stringify(c));
  const hook = (extra) => R.hook(Object.assign({ session_id: c.sessionId.slice(0, 12) }, extra));
  const mine = () => ((read(R.home, 'sessions.json') || {}).t || []).find((x) => x.sessionId === c.sessionId);
  await hook({ hook_event_name: 'UserPromptSubmit', notice: true });
  await hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr comment 7 --body x' }, tool_response: { stdout: URL }, posted: { repo: 'acme/widgets', pr: 7, kind: 'comment', url: URL } });
  await until(() => mine() && mine().posted && mine().posted.url === URL, 'the post to be saved with no other event');
  await hook({ hook_event_name: 'UserPromptSubmit' });
  await until(() => mine() && !mine().posted, 'the post to be cleared when the person types');
});
