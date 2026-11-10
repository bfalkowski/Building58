'use strict';
// A reviewer's first prompt that is typed, and whose Enter Claude Code does not take (T-209). On
// 2026-11-08, just after an Update restart, the reviewers of PR 154 and PR 155 sat for 12 minutes
// with their prompt typed in the box and never sent, and nothing noticed. The first prompt is now a
// saved delivery (relay/delivery.js, promptOnce): it counts as in only once a hook says a turn began,
// and until then the relay presses Enter again, or types it again. Through a real relay, with a fake
// claude that ignores Enter after a paste (FAKE_CLAUDE_DROP_ENTER in relay/test/fake-claude.sh).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep } = require('./helpers.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const PR = 'https://github.com/acme/widgets/pull/9';
// Long enough to go in as one paste (PASTE_FROM in relay/typed.js), as a real review prompt does.
const BRIEF = 'Review PR 9 for T-209. ' + 'Read every changed file, and check each claim in the PR. '.repeat(20);

async function reviewerOn(dropEnter) {
  const R = await relay({ RELAY_TOLD_CHECK_MS: '1500', FAKE_CLAUDE_DROP_ENTER: dropEnter });
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'fix\n');
  sh(repo, 'add', 'a.txt'); sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'the fix');
  sh(repo, 'push', '-qf', origin, 'HEAD:refs/pull/9/head');
  const started = await R.call('POST', '/checkouts', { from: repo, pr: PR, prompt: BRIEF });
  assert.strictEqual(started.status, 201, JSON.stringify(started.body));
  const reviewer = started.body;
  // Claude Code sends SessionStart as it starts, so the relay hears from it before its prompt.
  await R.hook({ hook_event_name: 'SessionStart', source: 'startup', session_id: reviewer.sessionId.slice(0, 12) });
  const sent = async () => (await R.screen(reviewer.id)).split('PASTED GOT[Review PR 9 for T-209').length - 1;
  const row = async () => (await R.call('GET', '/floor')).body.sessions.find((r) => r.terminal === reviewer.id);
  const owes = () => (JSON.parse(fs.readFileSync(path.join(R.home, '.office-world', 'sessions.json'), 'utf8')).t.find((s) => s.terminal === reviewer.id) || {}).owesPrompt;
  return { R, reviewer, sent, row, owes };
}

test('a reviewer whose first Enter is dropped still starts its turn, with no person, and gets the prompt once', async (t) => {
  const { R, reviewer, sent, row, owes } = await reviewerOn('first');
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  // Typed, and its Enter ignored: the text is still in the box.
  await until(async () => (await R.screen(reviewer.id)).includes('❯ Review PR 9 for T-209'), 'the prompt typed, and left in the box');
  assert.strictEqual(await sent(), 0, 'not sent by the first Enter');
  // The relay's check finds no turn began, sees the text still shows, and presses Enter again.
  await until(async () => (await sent()) === 1, 'the prompt sent by the relay\'s second Enter', 100);
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: reviewer.sessionId.slice(0, 12) });
  await sleep(4000);  // past two more of the relay's checks
  assert.strictEqual(await sent(), 1, 'sent once, and not typed again once a turn began');
  const r = await row();
  assert.strictEqual(r.stuck, null);
  assert.match(r.state, /^working/);
  assert.strictEqual(owes(), undefined, 'no longer owed, once a turn began');
});

test('a reviewer that never takes its first prompt is handed to the person, with why', async (t) => {
  const { R, reviewer, sent, row, owes } = await reviewerOn('all');
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  await until(async () => (await R.screen(reviewer.id)).includes('❯ Review PR 9 for T-209'), 'the prompt typed');
  const stuck = await until(async () => { const r = await row(); return r.stuck && r; }, 'stuck after its tries', 200);
  assert.match(stuck.state, /^stuck: told 0 min ago and did not start, the note is still in its prompt, not sent$/);
  assert.strictEqual(stuck.desk.next.text, 'Waiting on you: it did not start on its first prompt, the note is still in its prompt, not sent. Open its session and press Enter if the prompt is still in its box, or answer what is on its screen. Stopping it drops the prompt');
  // Each try was Enter, since the text still showed: nothing was typed a second time.
  const screen = await R.screen(reviewer.id);
  assert.strictEqual(screen.split('❯ Review PR 9 for T-209').length - 1, 4, 'typed once, and Enter pressed four times: the first and three more tries');
  assert.strictEqual(await sent(), 0);
  assert.ok(owes(), 'still owed, so Bring back types it');
  const posts = ((await R.call('GET', '/chat/office')).body.posts || []).map((p) => p.text);
  assert.ok(posts.some((x) => / did not start on its first prompt, the review of PR #9, so it is stuck: the note is still in its prompt, not sent\. The relay stopped trying after 3 more tries\. Open its session and press Enter if the prompt is still in its box, or answer what is on its screen\. Stopping it drops the prompt\.$/.test(x)), JSON.stringify(posts));
  // Past the told check after the last Enter, the stop verdict no longer says a hook may still come.
  const said = await until(async () => { const r = await row(); return /did not go in/.test(r.why) && r.why; }, 'the stop verdict to say it did not go in', 200);
  assert.match(said, /^Enter was pressed 0 min ago and no turn began, so its first prompt did not go in$/);
  await sleep(4000);
  assert.strictEqual((await R.screen(reviewer.id)).split('❯ Review PR 9 for T-209').length - 1, 4, 'then it stops trying');
});
