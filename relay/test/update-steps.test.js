'use strict';
// Update goes through merges one at a time while RELAY_ROLLBACK=1 (relay/update.js, relay/update-steps.js).
// As in relay/test/rollback.test.js, the relay here is a copy of this one in a git folder of its own, so
// each step really changes the code it runs, and a broken merge really breaks it.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, sleep, ROOT } = require('./helpers.js');
const steps = require('../update-steps.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (cwd, ...args) => sh(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args);
const commitAll = (cwd, message) => { sh(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', message); return sh(cwd, 'rev-parse', 'HEAD'); };
// A PR merged as GitHub merges one: a branch with one commit, merged into main with a merge commit.
function merge(src, pr, file, text, more) {
  sh(src, 'checkout', '-qb', 'pr-' + pr);
  for (const [f, t] of [[file, text]].concat(more || [])) {
    fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
    fs.appendFileSync(path.join(src, f), t);
  }
  commitAll(src, 'PR ' + pr);
  sh(src, 'checkout', '-q', 'main');
  git(src, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #' + pr + ' from someone/pr-' + pr, 'pr-' + pr);
  return sh(src, 'rev-parse', 'HEAD');
}
const waitFor = async (fn, what, ms) => {
  const end = Date.now() + (ms || 30000);
  while (Date.now() < end) { let v = null; try { v = await fn(); } catch (e) { /* between two relays */ } if (v) return v; await sleep(200); }
  throw new Error('Timed out waiting for ' + what);
};
const count = (text, re) => (text.match(re) || []).length;

test('the steps: each merge on main\'s own line, oldest first, and commits pushed straight to main after the last', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const src = path.join(home, 'r');
  sh(home, 'init', '-q', '-b', 'main', src);
  fs.writeFileSync(path.join(src, 'a.txt'), '1\n');
  const from = commitAll(src, 'first');
  const a = merge(src, 41, 'a.txt', '41\n');
  fs.appendFileSync(path.join(src, 'a.txt'), 'straight\n'); commitAll(src, 'pushed straight to main');
  const b = merge(src, 42, 'b.txt', '42\n');
  const c = merge(src, 43, 'c.txt', '43\n');
  assert.deepStrictEqual((await steps.list(src, from, c)).map((s) => [s.sha, s.pr]), [[a, 41], [b, 42], [c, 43]]);
  assert.deepStrictEqual(await steps.list(src, c, c), []);
  fs.appendFileSync(path.join(src, 'a.txt'), 'last\n');
  const d = commitAll(src, 'a fix (#44)');
  assert.deepStrictEqual((await steps.list(src, b, d)).map((s) => [s.sha, s.pr]), [[c, 43], [d, 44]], 'the commit after the last merge is a step of its own');
  assert.strictEqual(steps.name({ sha: d, pr: null }), 'commit ' + d.slice(0, 7));
});

test('resume: what a relay that just started does with the loop it finds', () => {
  const loop = { steps: [{ sha: 'aaa' }, { sha: 'bbb' }], at: 1, restartAt: new Date().toISOString() };
  const now = Date.now();
  assert.strictEqual(steps.resume(null, { loaded: 'bbb', now }).go, 'none');
  assert.strictEqual(steps.resume(loop, { loaded: 'bbb', back: null, now }).go, 'check');
  assert.strictEqual(steps.resume(loop, { loaded: 'aaa', back: { failed: 'bbb', why: 'it stopped' }, now }).go, 'failed');
  assert.match(steps.resume(loop, { loaded: 'ccc', back: null, now }).why, /runs ccc/);
  assert.match(steps.resume(loop, { loaded: 'bbb', back: null, now: now + steps.STALE + 1000 }).why, /more than 15 minutes/);
});

test('Update goes through merges one at a time, by itself', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-')));
  const src = path.join(home, 'src'), origin = path.join(home, 'origin.git'), dir = path.join(home, 'relay-folder');
  sh(home, 'init', '-q', '-b', 'main', src);
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'relay', 'office', 'shared', 'package.json'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of files) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(src, f));
  }
  const first = commitAll(src, 'the relay');
  sh(home, 'clone', '-q', '--bare', src, origin); sh(home, 'clone', '-q', origin, dir); sh(src, 'remote', 'add', 'origin', origin);
  const push = () => sh(src, 'push', '-q', 'origin', 'main');
  const goodFile = path.join(home, '.office-world', 'good-commit.json');
  const good = () => { try { return JSON.parse(fs.readFileSync(goodFile, 'utf8')); } catch (e) { return {}; } };

  const R = await relay({ RELAY_ROLLBACK: '1', RELAY_RESUME: '1', RELAY_ROLLBACK_SECONDS: '15' }, home, { root: dir });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const get = async () => (await R.call('GET', '/update')).body;
  // The loop has ended once no update is under way and the note says how it ended.
  const ended = (re, ms) => waitFor(async () => { const g = await get(); return !g.update && re.test(g.note || '') && g; }, 'the loop to end', ms || 90000);
  await waitFor(() => good().commit === first, 'the first commit to pass its check');

  await t.test('three merges are three steps, oldest first, and a page-only merge needs no restart', async () => {
    const restarts = count(R.output(), /Starting the relay again/g);
    const a = merge(src, 41, 'relay/floor.js', '// PR 41\n');
    const b = merge(src, 42, 'office/x.html', '<p>PR 42</p>\n');
    // The supervisor loads once, so a merge that changes it needs a stop and start by hand, and the loop says so.
    const c = merge(src, 43, 'relay/supervisor.js', '// PR 43\n');
    push();
    const r = await R.call('POST', '/update', {});
    assert.strictEqual(r.status, 202, r.body.message);
    assert.match(r.body.message, /3 merges\. Update takes them one at a time, oldest first: PR 41, PR 42, PR 43/);
    assert.deepStrictEqual({ at: r.body.update.step.at, of: r.body.update.step.of, name: r.body.update.step.name }, { at: 1, of: 3, name: 'PR 41' });
    assert.match(r.body.message, /relay\/supervisor\.js changed too\. It runs until you stop the relay yourself/);
    const g = await ended(/Update is done: 3 merges in/);
    assert.match(g.note, /relay\/supervisor\.js changed too\. It runs until you stop the relay yourself, so stop and start it once/);
    assert.match(R.output(), /3 of 3, PR 43 changes relay files, so the relay restarts on it once no session is in a turn\. relay\/supervisor\.js changed too/);
    const out = R.output();
    assert.match(out, /Update: 1 of 3, PR 41 changes relay files[\s\S]*Update: 1 of 3, PR 41 passed its check[\s\S]*Update: 2 of 3, PR 42 changes no relay file[\s\S]*Update: 3 of 3, PR 43 changes relay files[\s\S]*Update: 3 of 3, PR 43 passed its check/);
    assert.strictEqual(count(out, /Starting the relay again/g) - restarts, 2, 'a restart for PR 41 and PR 43, none for PR 42');
    assert.strictEqual(g.reloads, 0, 'the page step was made by a relay that has since restarted');
    assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), c);
    assert.strictEqual(sh(dir, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.strictEqual(good().commit, c);
    assert.ok(a && b);
    assert.strictEqual(fs.existsSync(path.join(home, '.office-world', 'update-steps.json')), false, 'the loop leaves no file behind');
  });

  const s = (await R.call('POST', '/terminals', { cwd: dir })).body;
  const talk = () => R.hook({ hook_event_name: 'UserPromptSubmit', session_id: s.sessionId.slice(0, 12) });
  const idle = () => R.hook({ hook_event_name: 'Stop', session_id: s.sessionId.slice(0, 12) });

  let pr45;
  await t.test('the person can stop it between steps: the merges before stay in, and the rest wait', async () => {
    const before = sh(dir, 'rev-parse', 'HEAD');
    const d = merge(src, 44, 'office/x.html', '<p>PR 44</p>\n');
    pr45 = merge(src, 45, 'relay/floor.js', '// PR 45\n');
    push();
    await talk();  // a session in a turn holds the restart PR 45 needs
    const r = await R.call('POST', '/update', {});
    assert.strictEqual(r.status, 202, r.body.message);
    const waiting = await waitFor(async () => { const g = await get(); return g.update && g.update.state === 'waiting' && g.update; }, 'step 2 to wait for a quiet moment');
    assert.strictEqual(waiting.step.at, 2); assert.strictEqual(waiting.step.name, 'PR 45');
    assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), d, 'PR 44 went in with no restart');
    assert.notStrictEqual(d, before);
    await R.call('POST', '/update', { cancel: true });
    const g = await ended(/Update stopped at 2 of 2, PR 45, before its restart: you stopped it\. PR 44 is in\. PR 45 waits for the next Update\./, 5000);
    assert.strictEqual(g.reloads, 1, 'a page that followed it reloads for PR 44');
    assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), d);
    await idle();
  });

  await t.test('the first failed check stops the loop, and only that merge goes out', async () => {
    const e = merge(src, 46, 'relay/floor.js', 'throw new Error(\'PR 46 breaks the relay\');\n', [['relay/session-host.js', '// PR 46\n']]);
    merge(src, 47, 'relay/floor.js', '// PR 47\n');
    push();
    const r = await R.call('POST', '/update', {});
    assert.strictEqual(r.status, 202, r.body.message);
    assert.match(r.body.message, /PR 45, PR 46, PR 47/);
    assert.match(r.body.message, /relay\/session-host\.js changed too/, 'the start names a file that loads once');
    const g = await ended(/Update stopped at 2 of 3, PR 46/);
    assert.match(g.note, new RegExp('PR 46 \\(' + e.slice(0, 7) + '\\): the new relay failed its check, since it stopped with exit code 1\\. Update went back to ' + pr45.slice(0, 7) + ', so only that merge is out\\. PR 45 is in\\. PR 47 waits for the next Update\\.'));
    assert.doesNotMatch(g.note, /session-host\.js/, 'PR 46 is out, so there is nothing new to stop and start for');
    assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), pr45, 'the folder is on PR 45, the merge before the broken one');
    assert.strictEqual(g.rollback.failed, e);
    assert.match(R.output(), /PR 46 breaks the relay/);
    const back = await waitFor(async () => { const l = (await R.call('GET', '/terminals')).body.terminals; return l.length === 1 && l[0]; }, 'the session');
    assert.strictEqual(back.sessionId, s.sessionId);
  });

  await t.test('merges after the failed one wait', async () => {
    const r = await R.call('POST', '/update', {});
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'not_main');
  });
});
