'use strict';
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until } = require('./helpers.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commit = (cwd, file, text) => { fs.writeFileSync(path.join(cwd, file), text); sh(cwd, 'add', file); sh(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'change ' + file); return sh(cwd, 'rev-parse', 'HEAD'); };
const worktrees = (repo) => sh(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;
const branches = (repo) => sh(repo, 'branch', '--format=%(refname:short)').split('\n');

function helpers(R) {
  const add = (from) => R.call('POST', '/checkouts', { from });
  const stop = async (id) => { await R.call('POST', '/terminals/' + id + '/stop', {}); await until(async () => !(await R.call('GET', '/terminals')).body.terminals.some((x) => x.id === id), 'it to stop'); };
  const listed = async (id) => (await R.call('GET', '/checkouts')).body.checkouts.find((c) => c.id === id);
  const gone = (id) => until(async () => !(await listed(id)), 'the checkout to go');
  const talk = async (t) => { await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: t.sessionId.slice(0, 12) }); await until(async () => (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === t.id).talked, 'the session to talk'); };
  const idle = async (c) => until(async () => { const v = await listed(c); return v && !v.running && v; }, 'it to be free');
  // A review's checkout is kept only once the relay has looked at what the session left, after the session
  // ends (settle in relay/checkouts.js). Changing the files before that look races it, so wait for left.
  const kept = async (c) => until(async () => { const v = await listed(c); return v && !v.running && v.left && v; }, 'the relay to keep it');
  return { add, stop, listed, gone, talk, idle, kept };
}

test('Add worker', async (t) => {
  const R = await relay(), repo = makeRepo(R.home), { add, stop, listed, gone, talk, idle } = helpers(R);
  t.after(R.stop);

  await t.test('two workers on one folder have separate checkouts, and the folder does not change', async () => {
    const head = sh(repo, 'rev-parse', 'HEAD');
    const a = (await add(repo)).body, b = (await add(repo)).body;
    assert.notStrictEqual(a.cwd, b.cwd);
    for (const w of [a, b]) {
      assert.strictEqual(path.dirname(w.cwd), path.join(repo, '.worktrees'));
      assert.strictEqual(w.from, repo);
      assert.strictEqual(w.project, 'repo');
      assert.strictEqual(sh(w.cwd, 'rev-parse', 'HEAD'), head);
      assert.strictEqual(sh(w.cwd, 'symbolic-ref', '--short', 'HEAD'), w.checkout.branch);
    }
    fs.writeFileSync(path.join(a.cwd, 'a.txt'), 'changed by a\n');
    assert.strictEqual(fs.readFileSync(path.join(b.cwd, 'a.txt'), 'utf8'), 'hi\n');
    assert.strictEqual(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'hi\n');
    assert.strictEqual(sh(repo, 'status', '--porcelain'), '');
    assert.strictEqual(sh(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
    fs.writeFileSync(path.join(a.cwd, 'a.txt'), 'hi\n');
    await stop(a.id); await stop(b.id);
    await gone(a.checkout.id); await gone(b.checkout.id);
  });
  await t.test('a worker who never talked leaves nothing behind', async () => {
    assert.strictEqual(worktrees(repo), 1);
    assert.deepStrictEqual(branches(repo), ['main']);
  });
  await t.test('a worker who talked keeps the checkout for Resume, until Clean up', async () => {
    const w = (await add(repo)).body;
    await talk(w);
    await stop(w.id);
    assert.ok(!(await idle(w.checkout.id)).running);
    assert.ok(fs.existsSync(w.cwd));
    const back = (await R.call('POST', '/terminals', { cwd: w.cwd, resume: w.sessionId })).body;  // Resume stays in that folder
    assert.strictEqual(back.cwd, w.cwd);
    assert.strictEqual((await R.call('POST', '/checkouts/' + w.checkout.id + '/clean', {})).body.error, 'in_use');
    await stop(back.id);
    const r = await R.call('POST', '/checkouts/' + w.checkout.id + '/clean', {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.branches, []);
    assert.ok(!fs.existsSync(w.cwd));
    assert.deepStrictEqual(branches(repo), ['main']);
    assert.strictEqual(await listed(w.checkout.id), undefined);
  });
  await t.test('uncommitted work stops Clean up, and the checkout stays', async () => {
    const w = (await add(repo)).body;
    await talk(w);
    fs.writeFileSync(path.join(w.cwd, 'new.txt'), 'wip\n');
    await stop(w.id); await idle(w.checkout.id);
    const r = await R.call('POST', '/checkouts/' + w.checkout.id + '/clean', {});
    assert.strictEqual(r.body.error, 'dirty');
    assert.ok(fs.existsSync(path.join(w.cwd, 'new.txt')));
    fs.rmSync(path.join(w.cwd, 'new.txt'));
    assert.strictEqual((await R.call('POST', '/checkouts/' + w.checkout.id + '/clean', {})).status, 200);
  });
  await t.test('a session that never talked but changed something keeps its checkout', async () => {
    const w = (await add(repo)).body;
    fs.writeFileSync(path.join(w.cwd, 'new.txt'), 'wip\n');
    await stop(w.id); await idle(w.checkout.id);
    assert.ok(fs.existsSync(path.join(w.cwd, 'new.txt')));
    fs.rmSync(path.join(w.cwd, 'new.txt'));
    await R.call('POST', '/checkouts/' + w.checkout.id + '/clean', {});
  });
  await t.test('Clean up keeps a branch with new commits', async () => {
    const w = (await add(repo)).body;
    const tip = commit(w.cwd, 'b.txt', 'work\n');
    await stop(w.id); await idle(w.checkout.id);
    const r = await R.call('POST', '/checkouts/' + w.checkout.id + '/clean', {});
    assert.deepStrictEqual(r.body.branches, [w.checkout.branch]);
    assert.ok(!fs.existsSync(w.cwd));
    assert.strictEqual(sh(repo, 'rev-parse', w.checkout.branch), tip);
    sh(repo, 'branch', '-D', w.checkout.branch);
  });
  await t.test('a worker whose session restarted on compact or /clear keeps the checkout, and talked still means this session', async () => {
    for (const source of ['compact', 'clear']) {
      const w = (await add(repo)).body;
      await talk(w);
      const fresh = crypto.randomUUID();
      await R.hook({ hook_event_name: 'SessionStart', source, session_id: fresh.slice(0, 12), full_session_id: fresh, terminal: w.id });
      await until(async () => (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === w.id).sessionId === fresh, 'the new session');
      assert.strictEqual((await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === w.id).talked, false);
      assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: w.id, board: true })).body.error, 'no_conversation');
      await stop(w.id); await idle(w.checkout.id);
      assert.ok(fs.existsSync(w.cwd), source);
      assert.strictEqual((await R.call('POST', '/checkouts/' + w.checkout.id + '/clean', {})).status, 200);
    }
  });
  await t.test('a worker spoken to with no hook reaching this relay keeps the checkout', async () => {
    const w = (await add(repo)).body;
    await R.call('POST', '/terminals/' + w.id + '/input', { data: 'look into this\r' });
    await stop(w.id); await idle(w.checkout.id);
    assert.ok(fs.existsSync(w.cwd));
    assert.strictEqual((await R.call('POST', '/checkouts/' + w.checkout.id + '/clean', {})).status, 200);
  });
  await t.test('what a terminal answers by itself, with no Enter, does not count as speaking', async () => {
    const w = (await add(repo)).body;
    await R.call('POST', '/terminals/' + w.id + '/input', { data: '\x1b[1;1R' });
    await stop(w.id); await gone(w.checkout.id);
    assert.ok(!fs.existsSync(w.cwd));
  });
  await t.test('Clean up names ignored files and deletes them only after a yes that covers them', async () => {
    fs.appendFileSync(path.join(sh(repo, 'rev-parse', '--absolute-git-dir'), 'info', 'exclude'), '.env\nbuild/\n');
    const w = (await add(repo)).body, clean = (body) => R.call('POST', '/checkouts/' + w.checkout.id + '/clean', body);
    fs.writeFileSync(path.join(w.cwd, '.env'), 'SECRET=1\n');
    await stop(w.id); await idle(w.checkout.id);
    const asked = await clean({});
    assert.strictEqual(asked.status, 409);
    assert.strictEqual(asked.body.error, 'ignored');
    assert.deepStrictEqual(asked.body.ignored, ['.env']);
    assert.match(asked.body.message, /\.env/);
    assert.ok(fs.existsSync(path.join(w.cwd, '.env')));
    fs.mkdirSync(path.join(w.cwd, 'build')); fs.writeFileSync(path.join(w.cwd, 'build', 'x'), 'x');
    const again = await clean({ ignored: asked.body.ignored });  // a new one since the question
    assert.deepStrictEqual(again.body.ignored.sort(), ['.env', 'build/']);
    assert.ok(fs.existsSync(path.join(w.cwd, '.env')));
    assert.strictEqual((await clean({ ignored: again.body.ignored })).status, 200);
    assert.ok(!fs.existsSync(w.cwd));
  });
  await t.test('a session that never spoke but left an ignored file keeps its checkout', async () => {
    const w = (await add(repo)).body;
    fs.writeFileSync(path.join(w.cwd, '.env'), 'SECRET=1\n');
    await stop(w.id); await idle(w.checkout.id);
    assert.ok(fs.existsSync(path.join(w.cwd, '.env')));
    assert.strictEqual((await R.call('POST', '/checkouts/' + w.checkout.id + '/clean', { ignored: ['.env'] })).status, 200);
  });
  await t.test('uncommitted work is refused first, without asking about ignored files', async () => {
    const w = (await add(repo)).body;
    fs.writeFileSync(path.join(w.cwd, '.env'), 'SECRET=1\n');
    fs.writeFileSync(path.join(w.cwd, 'new.txt'), 'wip\n');
    await stop(w.id); await idle(w.checkout.id);
    const r = await R.call('POST', '/checkouts/' + w.checkout.id + '/clean', {});
    assert.strictEqual(r.body.error, 'dirty');
    fs.rmSync(path.join(w.cwd, 'new.txt'));
    assert.strictEqual((await R.call('POST', '/checkouts/' + w.checkout.id + '/clean', { ignored: ['.env'] })).status, 200);
  });
  await t.test('a session resumed through a symlink still holds the checkout', async () => {
    const w = (await add(repo)).body;
    await talk(w); await stop(w.id); await idle(w.checkout.id);
    const link = path.join(R.home, 'link');
    fs.symlinkSync(w.cwd, link);
    const back = (await R.call('POST', '/terminals', { cwd: link, resume: w.sessionId })).body;
    assert.strictEqual((await listed(w.checkout.id)).running, true);
    assert.strictEqual((await R.call('POST', '/checkouts/' + w.checkout.id + '/clean', {})).body.error, 'in_use');
    await stop(back.id); fs.unlinkSync(link);
    assert.strictEqual((await R.call('POST', '/checkouts/' + w.checkout.id + '/clean', {})).status, 200);
  });
  await t.test('a branch git will not delete is reported as still there, not as a refusal', async () => {
    const w = (await add(repo)).body;
    await talk(w); await stop(w.id); await idle(w.checkout.id);
    sh(repo, 'checkout', '-q', '--ignore-other-worktrees', w.checkout.branch);
    const r = await R.call('POST', '/checkouts/' + w.checkout.id + '/clean', {});
    sh(repo, 'checkout', '-q', 'main');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.branches, [w.checkout.branch]);
    assert.ok(!fs.existsSync(w.cwd));
    sh(repo, 'branch', '-D', w.checkout.branch);
  });
  await t.test('Clean up names a branch the worker made themselves', async () => {
    const w = (await add(repo)).body;
    sh(w.cwd, 'checkout', '-q', '-b', 'fix-thing');
    const tip = commit(w.cwd, 'fix.txt', 'fix\n');
    await stop(w.id); await idle(w.checkout.id);
    const r = await R.call('POST', '/checkouts/' + w.checkout.id + '/clean', {});
    assert.deepStrictEqual(r.body.branches, ['fix-thing']);
    assert.strictEqual(sh(repo, 'rev-parse', 'fix-thing'), tip);
    assert.ok(!branches(repo).includes(w.checkout.branch));
    sh(repo, 'branch', '-D', 'fix-thing');
  });
  await t.test('a checkout holding another checkout is not removed, by itself or by Clean up', async () => {
    const w = (await add(repo)).body, nested = path.join(w.cwd, '.worktrees', 'inner');
    sh(repo, 'worktree', 'add', '-q', '-b', 'inner', nested);
    fs.writeFileSync(path.join(nested, 'new.txt'), 'wip\n');
    await stop(w.id); await idle(w.checkout.id);
    assert.ok(fs.existsSync(path.join(nested, 'new.txt')));
    const r = await R.call('POST', '/checkouts/' + w.checkout.id + '/clean', {});
    assert.strictEqual(r.body.error, 'dirty');
    assert.match(r.body.message, /holds another checkout/);
    sh(repo, 'worktree', 'remove', '--force', nested); sh(repo, 'branch', '-D', 'inner');
    assert.strictEqual((await R.call('POST', '/checkouts/' + w.checkout.id + '/clean', {})).status, 200);
  });
  await t.test('a task started from a worker\'s checkout goes under the repo, on the worker\'s branch', async () => {
    const w = (await add(repo)).body;
    const task = (await R.call('POST', '/tasks', { title: 'Nested', repo: w.cwd })).body.task;
    assert.strictEqual(path.dirname(task.worktree), path.join(repo, '.worktrees'));
    assert.strictEqual(task.base, w.checkout.branch);
    await stop(task.worker.terminal); await stop(w.id); await gone(w.checkout.id);
    assert.ok(fs.existsSync(task.worktree));
    await R.call('POST', '/tasks/' + task.id + '/move', { to: 'done' });
    assert.strictEqual((await R.call('POST', '/tasks/' + task.id + '/clean', {})).status, 200);
    sh(repo, 'branch', '-D', task.branch);
  });
  await t.test('a second relay leaves alone the checkouts of the one that owns the file', async () => {
    const w = (await add(repo)).body;
    const second = await relay({}, R.home);
    t.after(second.stop);
    await until(() => /owns .*checkouts\.json/.test(second.output()), 'the warning');
    assert.deepStrictEqual((await second.call('GET', '/checkouts')).body.checkouts, []);
    assert.strictEqual((await second.call('POST', '/checkouts/' + w.checkout.id + '/clean', {})).status, 404);
    assert.ok(fs.existsSync(w.cwd));
    await stop(w.id); await gone(w.checkout.id);
  });
  await t.test('a worker started from a linked worktree branches from it, under the repo itself', async () => {
    const linked = path.join(R.home, 'linked');
    sh(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
    const tip = commit(linked, 'f.txt', 'feature\n');
    const w = (await add(linked)).body;
    assert.strictEqual(path.dirname(w.cwd), path.join(repo, '.worktrees'));
    assert.strictEqual(sh(w.cwd, 'rev-parse', 'HEAD'), tip);
    assert.strictEqual(w.checkout.from, linked);
    assert.strictEqual(sh(linked, 'symbolic-ref', '--short', 'HEAD'), 'feature');
    await stop(w.id); await gone(w.checkout.id);
    sh(repo, 'worktree', 'remove', linked);
  });
  await t.test('a subfolder of the repo starts in the same subfolder', async () => {
    fs.mkdirSync(path.join(repo, 'sub'));
    commit(repo, 'sub/s.txt', 's\n');
    const w = (await add(path.join(repo, 'sub'))).body;
    assert.strictEqual(path.basename(w.cwd), 'sub');
    assert.strictEqual(w.cwd, path.join(w.checkout.path, 'sub'));
    await stop(w.id); await gone(w.checkout.id);
  });
  await t.test('a detached checkout does not lose its commits to Clean up', async () => {
    const w = (await add(repo)).body;
    sh(w.cwd, 'checkout', '-q', '--detach');
    const tip = commit(w.cwd, 'd.txt', 'detached\n');
    await stop(w.id); await idle(w.checkout.id);
    const r = await R.call('POST', '/checkouts/' + w.checkout.id + '/clean', {});
    assert.deepStrictEqual(r.body.branches, ['kept-' + w.checkout.id]);
    assert.strictEqual(sh(repo, 'rev-parse', r.body.branches[0]), tip);
    sh(repo, 'branch', '-D', r.body.branches[0]);
  });
  await t.test('a folder outside git just starts there', async () => {
    const plain = path.join(R.home, 'plain');
    fs.mkdirSync(plain);
    const r = await add(plain);
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.cwd, plain);
    assert.strictEqual(r.body.checkout, undefined);
    await stop(r.body.id);
  });
  await t.test('a mistyped folder is named', async () => {
    const r = await add(path.join(R.home, 'nowhere'));
    assert.strictEqual(r.status, 400);
    assert.match(r.body.message, /There is no folder/);
  });
  await t.test('a repo with no commits says so', async () => {
    const empty = path.join(R.home, 'empty');
    sh(R.home, 'init', '-q', empty);
    const r = await add(empty);
    assert.strictEqual(r.body.error, 'no_commits');
  });
  await t.test('using the folder itself makes no checkout, and neither does Get a review', async () => {
    const before = worktrees(repo);
    const r = (await R.call('POST', '/terminals', { cwd: repo })).body;
    assert.strictEqual(r.cwd, repo);
    assert.strictEqual(worktrees(repo), before);
    await stop(r.id);
  });
});

test('all the desks taken: the checkout is taken back', async (t) => {
  const R = await relay(), repo = makeRepo(R.home), { add } = helpers(R);
  t.after(R.stop);
  for (let i = 0; i < 9; i++) await R.call('POST', '/terminals', { cwd: R.home });
  const r = await add(repo);
  assert.strictEqual(r.body.error, 'full');
  assert.strictEqual(worktrees(repo), 1);
  assert.deepStrictEqual(branches(repo), ['main']);
});

test('automatic PR review', async (t) => {
  const R = await relay(), repo = makeRepo(R.home), { stop, listed, gone, idle, kept } = helpers(R);
  t.after(R.stop);
  // A local bare repo standing in for GitHub: the clone's remote is the github.com address.
  const origin = path.join(R.home, 'origin.git'), PR = 'https://github.com/acme/widgets/pull/7';
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'checkout', '-q', '-b', 'feature');
  const tip = commit(repo, 'pr.txt', 'the pr\n');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/pull/7/head');
  const review = (body) => R.call('POST', '/checkouts', Object.assign({ from: repo, pr: PR, prompt: 'Please review it.' }, body));
  const refs = () => sh(repo, 'for-each-ref', '--format=%(refname)', 'refs/office');

  let first;
  await t.test('a reviewer of an open PR works in their own checkout, on its latest commit', async () => {
    const r = await review();
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    first = r.body;
    assert.notStrictEqual(first.cwd, repo);
    assert.strictEqual(sh(first.cwd, 'rev-parse', 'HEAD'), tip);
    assert.strictEqual(first.role, 'reviewer');
    assert.strictEqual(first.title, 'Review PR #7');
    assert.strictEqual(first.from, repo);
  });
  await t.test('and does not change the author\'s folder, who keeps the branch', async () => {
    assert.strictEqual(sh(repo, 'symbolic-ref', '--short', 'HEAD'), 'feature');
    assert.strictEqual(sh(repo, 'rev-parse', 'HEAD'), tip);
    assert.strictEqual(sh(repo, 'status', '--porcelain'), '');
    assert.ok(!fs.existsSync(path.join(sh(repo, 'rev-parse', '--absolute-git-dir'), 'FETCH_HEAD')));
    fs.writeFileSync(path.join(first.cwd, 'pr.txt'), 'reviewer scribbles\n');
    assert.strictEqual(fs.readFileSync(path.join(repo, 'pr.txt'), 'utf8'), 'the pr\n');
    fs.writeFileSync(path.join(first.cwd, 'pr.txt'), 'the pr\n');
  });
  await t.test('the relay types the prompt in', async () => {
    await until(async () => (await R.screen(first.id)).includes('GOT[Please review it.'), 'the prompt');
  });
  await t.test('the checkout goes when the review ends', async () => {
    await stop(first.id); await gone(first.checkout.id);
    assert.ok(!fs.existsSync(first.cwd));
    assert.strictEqual(worktrees(repo), 1);
    assert.strictEqual(refs(), '');
    assert.deepStrictEqual(branches(repo), ['feature', 'main']);
  });
  await t.test('a reviewer started from a worker\'s checkout points the Folder field past it', async () => {
    const w = (await R.call('POST', '/checkouts', { from: repo })).body;
    const r = (await review({ from: w.cwd })).body;
    assert.strictEqual(r.from, repo);
    await stop(r.id); await gone(r.checkout.id);
    await stop(w.id); await gone(w.checkout.id);
  });
  await t.test('a review that left an ignored file stays for Clean up', async () => {
    fs.appendFileSync(path.join(sh(repo, 'rev-parse', '--absolute-git-dir'), 'info', 'exclude'), 'node_modules/\n');
    const r = (await review()).body;
    fs.mkdirSync(path.join(r.cwd, 'node_modules')); fs.writeFileSync(path.join(r.cwd, 'node_modules', 'x'), 'x');
    await stop(r.id);
    assert.match((await kept(r.checkout.id)).left, /node_modules/);
    assert.ok(fs.existsSync(r.cwd));
    assert.strictEqual((await R.call('POST', '/checkouts/' + r.checkout.id + '/clean', { ignored: ['node_modules/'] })).status, 200);
    assert.strictEqual(refs(), '');
  });
  await t.test('a review that wrote something stays for you to look at', async () => {
    const r = (await review()).body;
    fs.writeFileSync(path.join(r.cwd, 'notes.txt'), 'notes\n');
    await stop(r.id);
    assert.match((await kept(r.checkout.id)).left, /notes\.txt/);
    assert.ok(fs.existsSync(path.join(r.cwd, 'notes.txt')));
    fs.rmSync(path.join(r.cwd, 'notes.txt'));
    const c = await R.call('POST', '/checkouts/' + r.checkout.id + '/clean', {});
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
  });
  await t.test('Clean up the moment a review ends waits for the relay to look at the checkout (T-32)', async () => {
    // The relay looks at what a review left when its session ends, and removes the checkout if it is
    // empty. A Clean up during that look used to remove it as well, and one of the two got 409.
    // How long the look takes depends on the machine, so Clean up comes at a range of times after the end.
    for (let wait = 0; wait <= 300; wait += 30) {
      const r = (await review()).body;
      await R.call('POST', '/terminals/' + r.id + '/stop', {});
      await until(async () => { const v = await listed(r.checkout.id); return !v || !v.running; }, 'it to stop', 500);  // a fast machine may have taken it already
      await new Promise((res) => setTimeout(res, wait));
      const c = await R.call('POST', '/checkouts/' + r.checkout.id + '/clean', {});
      // Done, or already gone because the relay took it first. Never a 409.
      assert.ok(c.status === 200 || c.body.error === 'no_checkout', 'after ' + wait + ' ms: ' + JSON.stringify(c.body));
      await gone(r.checkout.id);
      assert.ok(!fs.existsSync(r.cwd));
      assert.strictEqual(worktrees(repo), 1);
    }
    assert.strictEqual(refs(), '');
  });
  await t.test('commits made in a review are kept on a branch', async () => {
    const r = (await review()).body;
    const made = commit(r.cwd, 'oops.txt', 'oops\n');
    await stop(r.id); await idle(r.checkout.id);
    const c = await R.call('POST', '/checkouts/' + r.checkout.id + '/clean', {});
    assert.deepStrictEqual(c.body.branches, ['kept-' + r.checkout.id]);
    assert.strictEqual(sh(repo, 'rev-parse', c.body.branches[0]), made);
    sh(repo, 'branch', '-D', c.body.branches[0]);
  });
  await t.test('a fetch for a review brings no tags into the repo', async () => {
    const other = path.join(R.home, 'tagger');
    sh(R.home, 'clone', '-q', origin, other);
    sh(other, 'fetch', '-q', 'origin', 'refs/pull/7/head');
    sh(other, 'tag', 'from-remote', 'FETCH_HEAD');
    sh(other, 'push', '-q', 'origin', 'from-remote');
    const r = (await review()).body;
    assert.strictEqual(sh(repo, 'tag', '--list'), '');
    await stop(r.id); await gone(r.checkout.id);
  });
  await t.test('a follow-up review starts only when a push moved the PR, however the push was written (T-70)', async () => {
    const { pushedIn } = require('../office-hook.js');
    const terminals = async () => (await R.call('GET', '/terminals')).body.terminals.length;
    // The way the T-21 Dev pushed to PR 35: quiet, and piped, so the exit status is hidden too.
    const push = (to) => {
      const cmd = 'git push -q ' + to + ' HEAD:refs/pull/7/head 2>&1 | tail -1; git log --oneline -1';
      const out = execFileSync('sh', ['-c', cmd], { cwd: repo, encoding: 'utf8' });
      return { cmd, response: { stdout: out, stderr: '' } };
    };
    const before = await terminals();
    // A push that failed: it printed an error, and the shell still said it worked.
    const failed = push('nowhere');
    assert.match(failed.response.stdout, /repository exists/, 'git said the push failed');
    assert.strictEqual(pushedIn(failed.cmd, failed.response), true, 'the hook cannot tell it failed');
    const same = await review({ unlessAt: tip });
    assert.deepStrictEqual(same.body, { ok: true, unchanged: true, commit: tip });
    assert.strictEqual(await terminals(), before, 'nobody started');
    assert.strictEqual(worktrees(repo), 1);
    assert.strictEqual(refs(), '');
    // An up-to-date push: the hook already says no, and the head check agrees.
    assert.strictEqual(pushedIn('git push', { stdout: 'Everything up-to-date' }), false);
    assert.strictEqual((await review({ unlessAt: tip })).body.unchanged, true);
    // A quiet piped push that moved the PR.
    const next = commit(repo, 'fix.txt', 'the fix\n');
    const moved = push(origin);
    assert.strictEqual(pushedIn(moved.cmd, moved.response), true, 'the hook counts it');
    const r = await review({ unlessAt: tip });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.checkout.commit, next);
    assert.strictEqual(sh(r.body.cwd, 'rev-parse', 'HEAD'), next);
    await stop(r.body.id); await gone(r.body.checkout.id);
    // A plain push that moved it, with nothing recorded to compare: a review starts, as before.
    const last = commit(repo, 'fix.txt', 'the second fix\n');
    sh(repo, 'push', origin, 'HEAD:refs/pull/7/head');
    assert.strictEqual(pushedIn('git push', { stdout: '' }), true);
    const plain = await review({ unlessAt: 'not a commit' });
    assert.strictEqual(plain.status, 201, JSON.stringify(plain.body));
    assert.strictEqual(plain.body.checkout.commit, last);
    await stop(plain.body.id); await gone(plain.body.checkout.id);
    sh(repo, 'push', '-q', '-f', origin, tip + ':refs/pull/7/head');  // the next tests expect the PR at tip
    sh(repo, 'reset', '-q', '--hard', tip);
  });
  await t.test('an unknown PR or a bad link starts nobody', async () => {
    const before = (await R.call('GET', '/terminals')).body.terminals.length;
    assert.strictEqual((await review({ pr: 'https://github.com/acme/widgets/pull/8' })).body.error, 'fetch');
    assert.strictEqual((await review({ pr: 'https://example.com/x' })).body.error, 'bad_pr');
    assert.strictEqual((await review({ from: path.join(R.home, 'nowhere') })).body.error, 'no_repo');
    assert.strictEqual((await R.call('GET', '/terminals')).body.terminals.length, before);
    assert.strictEqual(worktrees(repo), 1);
    assert.strictEqual(refs(), '');
  });
});

test('reading a remote\'s address', () => {
  const { parseRemote } = require('../checkouts.js');
  const repoOf = (url) => { const r = parseRemote(url); return r && [r.host, r.repo, r.ssh]; };
  assert.deepStrictEqual(repoOf('https://github.com/acme/widgets.git'), ['github.com', 'acme/widgets', false]);
  assert.deepStrictEqual(repoOf('https://user@github.com/acme/widgets/'), ['github.com', 'acme/widgets', false]);
  assert.deepStrictEqual(repoOf('git@github-work:acme/widgets.git'), ['github-work', 'acme/widgets', true]);
  assert.deepStrictEqual(repoOf('github.com:acme/widgets'), ['github.com', 'acme/widgets', true]);
  assert.deepStrictEqual(repoOf('ssh://git@ssh.github.com:443/acme/widgets.git'), ['ssh.github.com', 'acme/widgets', true]);
  assert.deepStrictEqual(repoOf('git://github.com/acme/widgets'), ['github.com', 'acme/widgets', false]);
  assert.strictEqual(parseRemote('git@github-work:acme/widgets.git').prefix, 'git@github-work:');
  assert.strictEqual(parseRemote('ssh://git@ssh.github.com:443/acme/widgets.git').prefix, 'ssh://git@ssh.github.com:443/');
  for (const local of ['/srv/git/widgets.git', '../widgets', 'file:///srv/acme/widgets.git', 'https://github.com/acme/widgets/extra']) assert.strictEqual(parseRemote(local), null, local);
});

test('what a review fetch gives ssh, so it never asks on the relay\'s terminal', () => {
  const { quietEnv } = require('../checkouts.js');
  const pick = (e) => [e.GIT_TERMINAL_PROMPT, e.SSH_ASKPASS, e.SSH_ASKPASS_REQUIRE];
  assert.deepStrictEqual(pick(quietEnv({ PATH: '/bin' })), ['0', '/usr/bin/false', 'force']);
  assert.deepStrictEqual(pick(quietEnv({ SSH_ASKPASS: '/opt/my-askpass' })), ['0', '/opt/my-askpass', 'prefer'], 'their own askpass, not the terminal');
  assert.deepStrictEqual(pick(quietEnv({ SSH_ASKPASS: '/opt/my-askpass', SSH_ASKPASS_REQUIRE: 'never' })), ['0', '/opt/my-askpass', 'never'], 'what they chose stands');
  assert.strictEqual(quietEnv({ PATH: '/bin' }).PATH, '/bin');
});

test('a review of a PR the clone names another way (T-8)', async (t) => {
  const fakeSsh = path.join(__dirname, 'fake-ssh.sh'), sshLog = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'fake-ssh-')), 'ssh.log');
  const R = await relay({ RELAY_SSH_CMD: fakeSsh, GIT_SSH_COMMAND: fakeSsh, FAKE_SSH_LOG: sshLog, FAKE_SSH_HOSTS: 'github-work=github.com gitlab-work=gitlab.com' });
  const repo = makeRepo(R.home), { stop, gone } = helpers(R);
  t.after(R.stop);
  // Local bare repos stand in for GitHub. The PR is acme/widgets#7, and the fork is me/widgets, which
  // holds the branch but not refs/pull. Each way of writing an address leads to one of them.
  const upstream = path.join(R.home, 'upstream.git'), fork = path.join(R.home, 'fork.git'), other = path.join(R.home, 'other.git');
  for (const bare of [upstream, fork, other]) sh(R.home, 'init', '-q', '--bare', bare);
  const to = (bare, ...urls) => '[url "' + bare + '"]\n' + urls.map((u) => '\tinsteadOf = ' + u + '\n').join('');
  fs.writeFileSync(path.join(R.home, '.gitconfig'),
    to(upstream, 'https://github.com/acme/widgets.git', 'git@github-work:acme/widgets.git', 'git@gitlab-work:acme/widgets.git',
      'ssh://git@ssh.github.com:443/acme/widgets.git', 'https://notgithub.com/acme/widgets.git') +
    to(fork, 'https://github.com/me/widgets.git', 'git@github-work:me/widgets.git', 'https://github.com/acme/gadgets.git') +
    to(other, 'https://github.com/acme/other.git') +
    to(path.join(R.home, 'nowhere.git'), 'https://github.com/acme/gone.git', 'git@github-work:acme/gone.git', 'https://x-access-token:ghp_FAKE@github.com/acme/gone.git', 'https://github.com/acme/by-ssh.git'));  // secret-check: allow (a fake token)
  sh(repo, 'checkout', '-q', '-b', 'feature');
  const tip = commit(repo, 'pr.txt', 'the pr\n');
  sh(repo, 'push', '-q', upstream, 'HEAD:refs/pull/7/head');
  sh(repo, 'push', '-q', fork, 'HEAD:refs/heads/feature');
  const elsewhere = path.join(R.home, 'elsewhere');  // another project, with no history in common
  fs.mkdirSync(elsewhere); sh(elsewhere, 'init', '-q');
  commit(elsewhere, 'x.txt', 'another project\n');
  sh(elsewhere, 'push', '-q', other, 'HEAD:refs/pull/7/head');

  const only = (url) => { for (const r of sh(repo, 'remote').split('\n').filter(Boolean)) sh(repo, 'remote', 'remove', r); sh(repo, 'remote', 'add', 'origin', url); };
  const review = (pr) => R.call('POST', '/checkouts', { from: repo, pr: pr || 'https://github.com/acme/widgets/pull/7' });
  const refs = () => sh(repo, 'for-each-ref', '--format=%(refname)', 'refs/office');
  const reviewed = async (url, pr) => {
    only(url);
    const r = await review(pr);
    assert.strictEqual(r.status, 201, url + ': ' + JSON.stringify(r.body));
    assert.strictEqual(sh(r.body.cwd, 'rev-parse', 'HEAD'), tip, url);
    await stop(r.body.id); await gone(r.body.checkout.id);
    assert.strictEqual(refs(), '');
  };

  await t.test('a remote through an SSH host alias for github.com', () => reviewed('git@github-work:acme/widgets.git'));
  await t.test('a remote through ssh.github.com on port 443', () => reviewed('ssh://git@ssh.github.com:443/acme/widgets.git'));
  await t.test('a clone of a fork with only origin, which the PR\'s repo is fetched beside', () => reviewed('https://github.com/me/widgets.git'));
  await t.test('a clone of a fork through a host alias, fetched through the same alias', () => reviewed('git@github-work:me/widgets.git'));
  await t.test('a remote using the repo\'s old name', () => reviewed('https://github.com/acme/gadgets.git'));
  await t.test('a host that is not GitHub does not count, even through an alias', async () => {
    for (const url of ['https://notgithub.com/acme/widgets.git', 'git@gitlab-work:acme/widgets.git']) {
      only(url);
      const r = await review();
      assert.strictEqual(r.body.error, 'no_remote', url);
      assert.match(r.body.message, /no remote at github\.com/);
    }
  });
  await t.test('a PR of another project is fetched, refused, and leaves no ref', async () => {
    only('https://github.com/acme/widgets.git');
    const before = (await R.call('GET', '/terminals')).body.terminals.length;
    const r = await review('https://github.com/acme/other/pull/7');
    assert.strictEqual(r.body.error, 'unrelated', JSON.stringify(r.body));
    assert.match(r.body.message, /shares no history/);
    assert.strictEqual((await R.call('GET', '/terminals')).body.terminals.length, before);
    assert.strictEqual(worktrees(repo), 1);
    assert.strictEqual(refs(), '');
  });
  await t.test('when no address reaches the PR\'s repo, the message names each one tried', async () => {
    only('git@github-work:me/widgets.git');
    const r = await review('https://github.com/acme/gone/pull/7');
    assert.strictEqual(r.body.error, 'fetch');
    assert.match(r.body.message, /git@github-work:acme\/gone\.git: /);
    assert.match(r.body.message, /https:\/\/github\.com\/acme\/gone\.git: /);
    assert.strictEqual(refs(), '');
  });
  await t.test('a token in a remote\'s address stays out of the message and the log', async () => {
    only('https://x-access-token:ghp_FAKE@github.com/me/widgets.git');  // secret-check: allow (a fake token)
    const r = await review('https://github.com/acme/gone/pull/7');
    assert.strictEqual(r.body.error, 'fetch');
    assert.match(r.body.message, /https:\/\/github\.com\/acme\/gone\.git: /);
    assert.doesNotMatch(r.body.message, /ghp_FAKE|x-access-token/);
    await until(() => R.output().includes('No reviewer for https://github.com/acme/gone/pull/7'), 'the log line');
    assert.doesNotMatch(R.output(), /ghp_FAKE/);
  });
  await t.test('a clone with no commits yet gets a reason of its own, not unrelated', async () => {
    const empty = path.join(R.home, 'empty');
    fs.mkdirSync(empty); sh(empty, 'init', '-q');
    sh(empty, 'remote', 'add', 'origin', 'https://github.com/me/widgets.git');
    const r = await R.call('POST', '/checkouts', { from: empty, pr: 'https://github.com/acme/widgets/pull/7' });
    assert.strictEqual(r.body.error, 'no_commits', JSON.stringify(r.body));
    assert.match(r.body.message, /no commits yet/);
    assert.strictEqual(sh(empty, 'for-each-ref', 'refs/office'), '');
    assert.match(sh(empty, 'count-objects', '-v'), /^count: 0$[\s\S]*^in-pack: 0$/m, 'it was refused before any fetch');
  });
  await t.test('ssh asks for no passphrase on the relay\'s terminal', async () => {
    only('git@github-work:me/widgets.git');  // its address for acme/by-ssh leads to the real ssh, here the fake one
    const r = await review('https://github.com/acme/by-ssh/pull/7');
    assert.strictEqual(r.body.error, 'fetch');
    assert.match(r.body.message, /git@github-work:acme\/by-ssh\.git: .*Permission denied/);
    assert.match(fs.readFileSync(sshLog, 'utf8'), /^askpass=\/usr\/bin\/false require=force$/m);
  });
});

test('a relay restart', async (t) => {
  let R = await relay();
  const home = R.home, repo = makeRepo(home), origin = path.join(home, 'origin.git');
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  sh(home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/pull/7/head');
  const worker = (await R.call('POST', '/checkouts', { from: repo })).body;
  const reviewer = (await R.call('POST', '/checkouts', { from: repo, pr: 'https://github.com/acme/widgets/pull/7' })).body;
  await R.kill();
  R = await relay({}, home);

  await t.test('takes away the reviews, whose sessions ended with it', async () => {
    await until(() => !fs.existsSync(reviewer.cwd), 'the review checkout to go');
    await until(async () => !(await R.call('GET', '/checkouts')).body.checkouts.some((c) => c.id === reviewer.checkout.id), 'it to be forgotten');
  });
  await t.test('and leaves the workers for Clean up', async () => {
    const left = (await R.call('GET', '/checkouts')).body.checkouts;
    assert.strictEqual(left.length, 1);
    assert.strictEqual(left[0].id, worker.checkout.id);
    assert.strictEqual(left[0].running, false);
    assert.ok(fs.existsSync(worker.cwd));
    assert.strictEqual((await R.call('POST', '/checkouts/' + worker.checkout.id + '/clean', {})).status, 200);
    assert.ok(!fs.existsSync(worker.cwd));
  });
  await t.test('a checkout someone deleted by hand can still be cleaned up', async () => {
    const { talk, stop, idle } = helpers(R), again = (await R.call('POST', '/checkouts', { from: repo })).body;
    await talk(again);  // a worker someone spoke to stays for Clean up, so the relay does not take it away itself
    await stop(again.id);
    // Clean up answers in_use while the checkout is running, so wait for the checkout itself to say it is
    // not, as well as for the terminal to leave /terminals (T-131).
    await idle(again.checkout.id);
    fs.rmSync(again.cwd, { recursive: true });
    const cleaned = await R.call('POST', '/checkouts/' + again.checkout.id + '/clean', {});
    assert.strictEqual(cleaned.status, 200, JSON.stringify(cleaned.body));  // in_use or dirty says which state was wrong
    assert.strictEqual(worktrees(repo), 1);
    assert.deepStrictEqual(branches(repo), ['main']);
  });
});
