'use strict';
// An automatic reviewer gives its desk back once its review is posted and its turn has ended. The
// events go through the real hook (relay/office-hook.js), as Claude Code would send them.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep, ROOT } = require('./helpers.js');

const GRACE = 1500;
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const PR = 'https://github.com/acme/widgets/pull/7';
const COMMENTED = { stdout: 'https://github.com/acme/widgets/pull/7#issuecomment-42\n', stderr: '', interrupted: false };

test('a reviewer that has posted ends by itself', async (t) => {
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));  // the fake gh a huddle runs keeps its log here
  const R = await relay({ RELAY_REVIEW_GRACE_MS: String(GRACE), GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh }), repo = makeRepo(R.home);
  t.after(R.stop); t.after(() => fs.rmSync(gh, { recursive: true, force: true }));
  const origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/pull/7/head');

  // The real hook, fed what Claude Code would give it.
  const hook = (s, event, extra) => {
    const payload = Object.assign({ hook_event_name: event, session_id: s.sessionId, cwd: s.cwd }, extra);
    const r = spawnSync('node', [path.join(ROOT, 'relay', 'office-hook.js')], { input: JSON.stringify(payload), env: { ...process.env, HOME: R.home, OFFICE_RELAY_KEY: 'test-key', OFFICE_RELAY_URL: 'http://127.0.0.1:' + R.port, OFFICE_CHANNEL: 't' } });
    assert.strictEqual(r.status, 0);
  };
  // Events with nothing to trim go straight in: starting a hook process is slow on a busy machine.
  const say = (s, event) => R.hook({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) });
  const bash = (s, command, response, event) => hook(s, event || 'PostToolUse', { tool_name: 'Bash', tool_input: { command }, tool_response: response || { stdout: '', stderr: '' } });
  const terminals = async () => (await R.call('GET', '/terminals')).body;
  const running = async (s) => (await terminals()).terminals.some((x) => x.id === s.id);
  const reviewer = async (prompt) => { const r = await R.call('POST', '/checkouts', { from: repo, pr: PR, prompt }); assert.strictEqual(r.status, 201, JSON.stringify(r.body)); return r.body; };
  const listed = async (c) => (await R.call('GET', '/checkouts')).body.checkouts.find((x) => x.id === c.id);
  const stays = async (s) => { await sleep(GRACE + 800); assert.ok(await running(s), 'it should still be running'); };
  const stop = async (s) => { await R.call('POST', '/terminals/' + s.id + '/stop', {}); await until(async () => !(await running(s)), 'it to stop'); };

  await t.test('a posted comment, then the end of its turn: the session ends, its desk is free and its checkout goes', async () => {
    const s = await reviewer();
    await say(s, 'UserPromptSubmit');
    bash(s, 'gh pr comment 7 --body "Two findings; see below."', COMMENTED);
    await sleep(GRACE + 300);
    assert.ok(await running(s), 'nothing ends before its turn does');
    await say(s, 'Stop');
    await until(async () => !(await running(s)), 'the reviewer to leave');
    await until(async () => !(await listed(s.checkout)), 'the checkout to go');
    assert.ok(!fs.existsSync(s.cwd));
    const done = (await terminals()).finished[0];
    assert.deepStrictEqual([done.id, done.title, done.pr, done.kind, done.url], [s.id, 'Review PR #7', PR, 'comment', COMMENTED.stdout.trim()]);
    // The desk is free: nine more sessions fit.
    const more = [];
    for (let i = 0; i < 9; i++) { const r = await R.call('POST', '/terminals', { cwd: R.home }); assert.strictEqual(r.status, 201, JSON.stringify(r.body)); more.push(r.body); }
    for (const m of more) await stop(m);
  });
  await t.test('gh pr review counts too, and links the PR', async () => {
    const s = await reviewer();
    bash(s, 'cd ' + s.cwd + ' && gh pr review 7 -R acme/widgets --approve -b "Looks right."');
    await say(s, 'Stop');
    await until(async () => !(await running(s)), 'the reviewer to leave');
    const done = (await terminals()).finished[0];
    assert.deepStrictEqual([done.kind, done.url], ['approve', PR]);
  });
  await t.test('a failed post does not count', async () => {
    const s = await reviewer();
    bash(s, 'gh pr comment 7 --body "x"', { stdout: '', stderr: 'HTTP 502' }, 'PostToolUseFailure');
    await say(s, 'Stop');
    bash(s, 'gh pr comment 7 --body "x" || true', { stdout: '', stderr: 'HTTP 502' });  // the failure hidden, so no link came back
    bash(s, 'gh pr review 7 --help');
    // gh pr review prints nothing, so a failure hidden after it would look like a post. GitHub refuses
    // --approve on your own PR, and the room's reviewers use the PR author's account.
    for (const hidden of [' 2>&1 | tail -1', '; echo done', ' || true']) bash(s, 'gh pr review 7 -R acme/widgets --approve' + hidden);
    await say(s, 'Stop');
    await stays(s);
    await stop(s);
  });
  await t.test('a post to another PR does not count', async () => {
    const s = await reviewer();
    bash(s, 'gh pr comment 8 --body "x"', { stdout: 'https://github.com/acme/widgets/pull/8#issuecomment-1\n' });
    bash(s, 'gh pr review 7 -R acme/other --comment -b "x"');
    bash(s, 'GH_REPO=acme/other gh pr review 7 --approve');  // no repo named, so it could be another one's PR 7
    await say(s, 'Stop');
    await stays(s);
    await stop(s);
  });
  await t.test('a gh command quoted in the review\'s body is not a post', async () => {
    // The shape real claude used: the review written to a file with a heredoc, then posted.
    const s = await reviewer();
    bash(s, "cat > /tmp/review.md <<'EOF'\nI checked that gh pr review 7 --approve counts.\nEOF\ngh pr comment 8 --body-file /tmp/review.md", { stdout: 'https://github.com/acme/widgets/pull/8#issuecomment-5\n' });
    bash(s, 'echo "gh pr review 7 --approve"');
    await say(s, 'Stop');
    await stays(s);
    await stop(s);
  });
  await t.test('typing during the grace period keeps it', async () => {
    const s = await reviewer();
    bash(s, 'gh pr comment 7 --body "x"', COMMENTED);
    await say(s, 'Stop');
    // What xterm answers by itself, while old output replays or the mouse moves: none of it is typing.
    for (const reply of ['\x1b[I', '\x1b[O', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[12;5R', '\x1b]11;rgb:0c0c/0f0f/1414\x1b\\', '\x1b[<0;10;5M', '\x1b[M #!', '\x1bP>|xterm.js(5.5.0)\x1b\\']) {
      await R.call('POST', '/terminals/' + s.id + '/input', { data: reply });
    }
    await until(async () => !(await running(s)), 'the reviewer to leave');

    const k = await reviewer();
    bash(k, 'gh pr comment 7 --body "x"', COMMENTED);
    await say(k, 'Stop');
    await R.call('POST', '/terminals/' + k.id + '/input', { data: 'w' });
    await stays(k);
    await say(k, 'UserPromptSubmit'); await say(k, 'Stop');  // its answer to the person ends the turn, and it stays
    await stays(k);
    bash(k, 'gh pr comment 7 --body "And one more thing."', COMMENTED);  // asked for more, it posts again
    await say(k, 'Stop');
    await until(async () => !(await running(k)), 'the reviewer to leave after its second post');
  });
  await t.test('a new prompt from the person during the grace period keeps it', async () => {
    const s = await reviewer();
    bash(s, 'gh pr comment 7 --body "x"', COMMENTED);
    await say(s, 'Stop');
    await say(s, 'UserPromptSubmit');
    await stays(s);
    await say(s, 'Stop');
    await stays(s);
    await stop(s);
  });
  await t.test('a prompt the relay typed does not keep it, and a huddle in the grace period does not ask it', async () => {
    const s = await reviewer('Please review it.');
    await until(async () => (await R.screen(s.id)).includes('GOT[Please review it.'), 'the prompt');
    await say(s, 'UserPromptSubmit');  // the prompt the relay typed
    bash(s, 'gh pr comment 7 --body "x"', COMMENTED);
    await say(s, 'Stop');
    const h = await R.call('POST', '/huddle', { ask: true });
    assert.ok(h.status < 300, JSON.stringify(h.body));
    assert.match(JSON.stringify(h.body), /its review is posted and it is leaving, not asked/);
    await until(async () => !(await running(s)), 'the reviewer to leave');
    assert.ok(!(await R.screen(s.id).catch(() => '')).includes('HUDDLE-'));
  });
  await t.test('a review that left a file behind ends, and its checkout waits for Clean up with the reason', async () => {
    const s = await reviewer();
    fs.writeFileSync(path.join(s.cwd, 'notes.md'), 'scribbles\n');
    bash(s, 'gh pr comment 7 --body "x"', COMMENTED);
    await say(s, 'Stop');
    await until(async () => !(await running(s)), 'the reviewer to leave');
    const c = await until(async () => { const v = await listed(s.checkout); return v && !v.running && v.left && v; }, 'the reason');
    assert.match(c.left, /notes\.md/);
    assert.ok(fs.existsSync(path.join(s.cwd, 'notes.md')));
    fs.rmSync(path.join(s.cwd, 'notes.md'));
    assert.strictEqual((await R.call('POST', '/checkouts/' + c.id + '/clean', {})).status, 200);
  });
  await t.test('a session without the automatic reviewer\'s start that posts a comment keeps going', async () => {
    const worker = (await R.call('POST', '/checkouts', { from: repo })).body;  // Add worker
    const asked = (await R.call('POST', '/terminals', { cwd: repo, title: 'Review', role: 'reviewer', pr: PR })).body;  // Get a review, or any request naming a PR
    for (const s of [worker, asked]) { bash(s, 'gh pr comment 7 --body "x"', COMMENTED); await say(s, 'Stop'); }
    await stays(worker); assert.ok(await running(asked));
    await stop(worker); await stop(asked);
  });
});

test('the hook reports a post only for a gh command that ran and worked', () => {
  const { summarize } = require('../office-hook.js');
  const ok = { stdout: 'https://github.com/acme/widgets/pull/7#issuecomment-99\n' };
  const posted = (command, response) => summarize({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command }, tool_response: response || { stdout: '' } }).posted;
  assert.deepStrictEqual(posted('gh pr comment 7 --body "a; b"', ok), { pr: 7, repo: 'acme/widgets', kind: 'comment', url: ok.stdout.trim() });
  assert.deepStrictEqual(posted('cd x && gh pr review --request-changes -R acme/widgets 7 -b "x"'), { pr: 7, repo: 'acme/widgets', kind: 'request-changes', url: null });
  assert.deepStrictEqual(posted('gh pr review 7 --approve'), { pr: 7, repo: null, kind: 'approve', url: null }, 'the relay does not count a post with no repo');
  const reached = { stdout: '', gitOperation: { pr: { number: 7, url: 'https://github.com/acme/widgets/pull/7', action: 'reviewed' } } };
  assert.strictEqual(posted('gh pr review 7 --approve', reached).repo, 'acme/widgets');
  for (const shape of ['if true; then gh pr review 7 -a; fi', 'GH_DEBUG=1 gh pr review 7 -a', 'x=`gh pr review 7 -a`']) assert.strictEqual(posted(shape).pr, 7, shape);
  assert.deepStrictEqual(posted("cat > r.md <<'EOF'\nrun gh pr review 7 --approve\nEOF\ngh pr comment 7 --body-file r.md", ok).pr, 7);
  assert.deepStrictEqual(posted('gh pr comment 7 --body "$(cat <<EOF\ngh pr review 9 --approve\nEOF\n)"', ok).pr, 7);
  for (const not of ['echo gh pr review 7 --approve', 'echo "gh pr review 7 --approve"', "grep 'gh pr review 7' notes", 'gh pr review 7 --help', 'echo then gh pr review 7 -a', 'gh pr review -h', 'gh pr comment 7 --web', 'gh pr comment 7 --edit-last -b x', 'gh pr review -b x', 'gh pr view 7']) {
    assert.strictEqual(posted(not, ok), undefined, not);
  }
  assert.strictEqual(posted('gh pr comment 7 -b x || true', { stdout: '', stderr: 'HTTP 502' }), undefined);
  assert.strictEqual(posted('gh pr comment 8 -b x', ok), undefined);
  // A hidden exit code: gh pr review prints nothing, so only the exit code says it worked.
  for (const hidden of [' 2>&1 | tail -1', '; echo done', ' || true', ' &', '\necho done', ' && echo ok; true', ' |& cat']) {
    assert.strictEqual(posted('gh pr review 7 -R acme/widgets --approve' + hidden), undefined, hidden);
  }
  for (const shown of [' && echo ok', ' 2>&1', ' >/dev/null 2>&1 && echo ok', ' &>/dev/null', '\n', ' -F - <<\'EOF\'\nOne finding; see below | here.\nEOF', ' -b "$(cat <<\'EOF\'\nfine\nEOF\n)"']) {
    assert.strictEqual(posted('gh pr review 7 -R acme/widgets --approve' + shown).kind, 'approve', shown);
  }
  assert.ok(posted('gh pr comment 7 -b x; echo done', ok), 'gh pr comment has its link to show it worked');
  // Lines joined with a backslash are one command.
  assert.deepStrictEqual(posted('gh pr review 7 \\\n  --repo acme/widgets \\\n  --approve'), { pr: 7, repo: 'acme/widgets', kind: 'approve', url: null });
  // Two posts in one command: the last one counts.
  assert.strictEqual(posted('gh pr review 7 -R acme/widgets -c -b x && gh pr review 7 -R acme/widgets --request-changes -b y').kind, 'request-changes');
  assert.strictEqual(posted('gh pr review 7 -R acme/widgets -c -b x\ngh pr review 7 -R acme/widgets --approve -b y').kind, 'approve');
  // None of the command's words leave the hook.
  assert.doesNotMatch(JSON.stringify(summarize({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'gh pr comment 7 --body "secret words"' }, tool_response: ok })), /secret/);
});
