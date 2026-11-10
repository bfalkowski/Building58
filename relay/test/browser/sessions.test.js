// The Claude Code panel in a browser (relay/test/browser/page.js), with WebGL off: Add worker starts a
// session in its own checkout, or in the folder itself with Use this folder. Clean up asks before it
// deletes files git ignores. A reviewer that could not start says so, and the panel's refresh does not
// replace that before you can read it.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeRepo } = require('../helpers.js');
const { office, pageTest, screenText, errorsBut } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;

// Adds a worker from the panel, and waits for the fake claude to draw its last line before the prompt.
async function addWorker(p, folder, here) {
  const page = p.page;
  await page.fill('#cc-cwd', folder);
  await page.getByLabel('Use this folder').setChecked(!!here);
  const before = (await o.R.call('GET', '/terminals')).body.terminals.length;
  await page.click('#cc-start');
  await page.locator('#cc-status[data-state="on"]', { hasText: /^Running in / }).waitFor();
  await page.locator('#cc-term .xterm-rows', { hasText: 'child session:' }).waitFor();
  const terms = (await o.R.call('GET', '/terminals')).body.terminals;
  assert.strictEqual(terms.length, before + 1, 'one new session');
  return terms[terms.length - 1];
}
const runningIn = (p) => p.page.innerText('#cc-status').then((s) => s.replace(/^Running in (.*) · session \w+$/, '$1'));

pageTest('Add worker starts a session in its own checkout, and the terminal shows it', get, async (p) => {
  const repo = makeRepo(o.R.home, 'add-repo');
  await p.open();
  const t = await addWorker(p, repo, false);
  assert.notStrictEqual(t.cwd, repo, 'a checkout, not the folder');
  assert.strictEqual(t.from, repo);
  assert.strictEqual(await runningIn(p), t.cwd);
  assert.match(await screenText(p), /child session:/);
  // The session has a person on the Floor, and the panel is titled with their name.
  const name = (await p.page.innerText('#cc-title')).replace(/^Claude Code · /, '');
  assert.ok(name && name !== 'Claude Code', 'the panel names the person');
  await p.page.locator('#people li', { hasText: name }).waitFor();
  // What you type goes to that session.
  await p.page.click('#cc-term');
  await p.page.keyboard.type('hello there');
  await p.page.keyboard.press('Enter');
  await p.page.locator('#cc-term .xterm-rows', { hasText: 'GOT[hello there]' }).waitFor();
  assert.deepStrictEqual(p.errors, []);
});

pageTest('Use this folder starts the session in the folder itself', get, async (p) => {
  const repo = makeRepo(o.R.home, 'here-repo');
  await p.open();
  const t = await addWorker(p, repo, true);
  assert.strictEqual(t.cwd, repo);
  assert.strictEqual(await runningIn(p), repo);
  const branches = execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: repo, encoding: 'utf8' }).trim();
  assert.strictEqual(branches, 'main', 'no branch was made for it');
  assert.deepStrictEqual(p.errors, []);
});

pageTest('Clean up asks before it deletes files git ignores, then removes the checkout', get, async (p) => {
  const repo = makeRepo(o.R.home, 'clean-repo');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'secret.env\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'ignore'], { cwd: repo });
  await p.open();
  const t = await addWorker(p, repo, false);
  const checkout = (await o.R.call('GET', '/checkouts')).body.checkouts.find((c) => c.path === t.cwd);
  assert.ok(checkout, 'the relay lists its checkout');
  fs.writeFileSync(path.join(t.cwd, 'secret.env'), 'A=1\n');
  await p.page.click('#cc-stop');
  await p.page.locator('#cc-status', { hasText: /^Stopped\./ }).waitFor();

  const row = p.page.locator('.cc-ask', { hasText: 'Checkout with nobody in it: ' + t.cwd });
  await row.getByRole('button', { name: 'Clean up' }).click();
  const asking = p.page.locator('.cc-ask', { hasText: t.cwd + ' holds files git ignores, and Clean up would delete them: secret.env' });
  // Keep leaves it all where it was.
  await asking.getByRole('button', { name: 'Keep' }).click();
  await row.waitFor();
  assert.ok(fs.existsSync(path.join(t.cwd, 'secret.env')));
  await row.getByRole('button', { name: 'Clean up' }).click();
  await asking.getByRole('button', { name: 'Delete them too' }).click();
  await p.page.locator('#cc-status', { hasText: 'Removed ' + t.cwd + '.' }).waitFor();
  await row.waitFor({ state: 'detached' });
  assert.strictEqual(fs.existsSync(t.cwd), false, 'the checkout is gone');
  assert.deepStrictEqual(errorsBut(p, 409, '/channels/t/checkouts/' + checkout.id + '/clean'), [], 'only the 409s that ask about ignored files');
});

pageTest('a reviewer that could not start says why, and the refresh leaves that on screen', get, async (p) => {
  const folder = fs.mkdtempSync(path.join(o.R.home, 'gone-'));
  await p.open();
  await addWorker(p, folder, true);
  fs.rmSync(folder, { recursive: true });  // Get a review starts the reviewer in this folder, which is now gone
  await p.page.click('#cc-review');
  const said = 'Could not start a reviewer: There is no folder ' + folder + '.';
  const status = p.page.locator('#cc-status', { hasText: said });
  await status.waitFor();
  // The panel reads the sessions every two seconds, and each read can rewrite this line. The third answer
  // has arrived, so the page has handled at least two, and the message is still there.
  for (let i = 0; i < 3; i++) await p.page.waitForResponse((r) => new URL(r.url()).pathname === '/channels/t/terminals' && r.request().method() === 'GET');
  assert.strictEqual(await p.page.innerText('#cc-status'), said);
  assert.strictEqual(await p.page.getAttribute('#cc-status', 'data-state'), 'off');
  assert.ok(await status.isVisible());
  assert.deepStrictEqual(errorsBut(p, 400, '/channels/t/terminals'), [], 'only the 400 for the missing folder');
});

pageTest('the page draws the person the relay gives each session, whatever this browser kept', get, async (p) => {
  // What pages kept before the relay seated sessions (T-177): another session promised the first free person.
  await p.open();
  const free = (await p.page.evaluate(() => window.run.do({ action: 'state' }).then((r) => r.state.workers))).filter((x) => !x.lead && !x.session);
  assert.ok(free.length > 1, 'enough free people to show it');
  await p.page.evaluate((who) => localStorage.setItem('office.seats', JSON.stringify({ gone0000: { who, at: Date.now() } })), free[0].id);
  await p.page.reload(); await p.page.locator('#relay-status[data-state="on"]').waitFor();
  await p.page.waitForFunction(() => !/^Starting/.test(document.getElementById('cc-status').textContent));
  const t = await addWorker(p, makeRepo(o.R.home, 'seat-repo'), false);
  assert.strictEqual(t.seat, free[0].id, 'the relay gives the first free person, and nothing a browser kept steers it');
  assert.strictEqual((await p.page.innerText('#cc-title')).replace(/^Claude Code · /, ''), t.who, 'the panel names the person the relay gave');
  // Every session the relay runs is drawn at the person the relay says, on this page.
  const byTerminal = (rows) => rows.slice().sort((a, b) => a[0].localeCompare(b[0]));
  // A desk is a look, and the person there goes by the name the relay gave its session (relay/seats.js).
  const relayRows = (await o.R.call('GET', '/terminals')).body.terminals.map((x) => [x.id, x.seat, x.who]);
  await p.page.waitForFunction((n) => window.run.state().workers.filter((w) => w.session && w.session.terminal).length === n, relayRows.length);
  const drawn = await p.page.evaluate(() => window.run.state().workers.filter((w) => w.session && w.session.terminal).map((w) => [w.session.terminal, w.id, w.name]));
  assert.deepStrictEqual(byTerminal(drawn), byTerminal(relayRows));
  assert.notStrictEqual(t.who, free[0].name, 'a name from the pool, not the desk\'s own');
  await p.page.locator('#people li', { hasText: t.who }).waitFor();
  assert.strictEqual(await p.page.evaluate(() => localStorage.getItem('office.seats')), null, 'the page keeps no seats of its own');
  assert.deepStrictEqual(p.errors, []);
});

pageTest('Get a review uses the PR a session opened from your own terminal, once you resume it here (T-59)', get, async (p) => {
  await p.open();
  const sid = '5e550000-0000-4000-8000-00000000c0de', pr = 'https://github.com/o/r/pull/7';
  // A session from your own terminal opens a PR. It has no terminal here, and only the page hears this hook.
  await p.page.evaluate(([id, url]) => window.run.do({ action: 'hook', event: { hook_event_name: 'PostToolUse', session_id: id, tool_name: 'Bash', pr_url: url } }), [sid, pr]);
  await p.page.fill('#cc-resume', sid);
  const t = await addWorker(p, makeRepo(o.R.home, 'hook-pr-repo'), true);
  assert.strictEqual(t.sessionId, sid, 'the room resumed that session');
  assert.ok(!(t.work || {}).pr, 'the relay has no PR for it');
  const sent = p.page.waitForRequest((r) => new URL(r.url()).pathname === '/channels/t/checkouts' && r.method() === 'POST');
  await p.page.click('#cc-review');
  const body = JSON.parse((await sent).postData());
  assert.deepStrictEqual([body.pr, body.from], [pr, t.cwd], 'a review of the PR it opened, not of its folder');
});
