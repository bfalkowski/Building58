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
  await p.page.locator('#cards .desk', { hasText: name }).waitFor();
  // What you type goes to that session.
  await p.page.click('#cc-term');
  await p.page.keyboard.type('hello there');
  await p.page.keyboard.press('Enter');
  await p.page.locator('#cc-term .xterm-rows', { hasText: 'GOT[hello there]' }).waitFor();
  assert.deepStrictEqual(p.errors, []);
});

pageTest('keys typed while a send is on its way go together in the next one, so a slow relay does not cost a request a letter (T-613)', get, async (p) => {
  const repo = makeRepo(o.R.home, 'batch-repo');
  await p.open();
  await addWorker(p, repo, false);
  let sends = 0;
  await p.page.route(/\/terminals\/[0-9a-f]{12}\/input$/, async (r) => { sends++; await new Promise((d) => setTimeout(d, 300)); await r.continue(); });
  const text = 'typed fast through a slow relay';
  await p.page.click('#cc-term');
  await p.page.keyboard.type(text, { delay: 20 });
  await p.page.keyboard.press('Enter');
  await p.page.locator('#cc-term .xterm-rows', { hasText: 'GOT[' + text + ']' }).waitFor();
  assert.ok(sends < text.length / 2, 'the keys went in ' + sends + ' sends, for ' + text.length + ' letters');
  await p.page.unroute(/\/terminals\/[0-9a-f]{12}\/input$/);
});

pageTest('Enter goes in a send of its own, as the relay types it, not joined to the text before it (T-613)', get, async (p) => {
  const repo = makeRepo(o.R.home, 'enter-repo');
  await p.open();
  await addWorker(p, repo, false);
  const bodies = [];
  await p.page.route(/\/terminals\/[0-9a-f]{12}\/input$/, async (r) => { bodies.push(JSON.parse(r.request().postData()).data); await new Promise((d) => setTimeout(d, 300)); await r.continue(); });
  await p.page.click('#cc-term');
  await p.page.keyboard.type('enter alone', { delay: 10 });
  await p.page.keyboard.press('Enter');
  await p.page.locator('#cc-term .xterm-rows', { hasText: 'GOT[enter alone]' }).waitFor();
  assert.strictEqual(bodies[bodies.length - 1], '\r', 'the last send is Enter alone');
  assert.ok(!bodies.some((b) => b.length > 1 && /[\r\n]/.test(b)), 'no send joins text and Enter: ' + JSON.stringify(bodies));
  await p.page.unroute(/\/terminals\/[0-9a-f]{12}\/input$/);
});

pageTest('keys still waiting when you switch sessions go to the session they were typed in (T-613)', get, async (p) => {
  await p.open();
  const a = await addWorker(p, makeRepo(o.R.home, 'switch-a'), false);
  const b = await addWorker(p, makeRepo(o.R.home, 'switch-b'), false);
  const sent = [];
  await p.page.route(/\/terminals\/[0-9a-f]{12}\/input$/, async (r) => { sent.push({ id: r.request().url().match(/terminals\/([0-9a-f]{12})\/input/)[1], data: JSON.parse(r.request().postData()).data }); await new Promise((d) => setTimeout(d, 300)); await r.continue(); });
  const show = (id) => p.page.evaluate((t) => window.dispatchEvent(new CustomEvent('office:session', { detail: { terminal: t } })), id);
  await show(a.id);
  await p.page.click('#cc-term');
  await p.page.keyboard.type('only for a', { delay: 10 });
  await show(b.id);
  await p.page.click('#cc-term');
  await p.page.keyboard.type('only for b', { delay: 10 });
  await p.page.keyboard.press('Enter');
  await p.page.locator('#cc-term .xterm-rows', { hasText: 'GOT[only for b]' }).waitFor();
  const to = (id) => sent.filter((x) => x.id === id).map((x) => x.data).join('');
  assert.strictEqual(to(a.id), 'only for a', 'the keys typed for a reached a');
  assert.ok(!to(b.id).includes('for a'), 'none of a\'s keys reached b');
  await p.page.unroute(/\/terminals\/[0-9a-f]{12}\/input$/);
});

pageTest('after a send fails, the keys typed next still reach the session (T-613)', get, async (p) => {
  const repo = makeRepo(o.R.home, 'fail-repo');
  await p.open();
  await addWorker(p, repo, false);
  let first = true;
  await p.page.route(/\/terminals\/[0-9a-f]{12}\/input$/, async (r) => { if (first) { first = false; await r.abort(); return; } await r.continue(); });
  await p.page.click('#cc-term');
  const failed = p.page.waitForEvent('requestfailed', (r) => /\/input$/.test(r.url()));
  await p.page.keyboard.type('x');
  await failed;
  await p.page.keyboard.type('kept', { delay: 10 });
  await p.page.keyboard.press('Enter');
  await p.page.locator('#cc-term .xterm-rows', { hasText: 'GOT[kept]' }).waitFor();
  await p.page.unroute(/\/terminals\/[0-9a-f]{12}\/input$/);
  p.errors = p.errors.filter((e) => !/input|Failed to load resource|ERR_FAILED/.test(e));
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

// T-153: a PM checkout left with a file says it was the PM's.
pageTest('a checkout the PM left says it was the PM\'s', get, async (p) => {
  const repo = makeRepo(o.R.home, 'pm-repo');
  await p.open();
  const r = await o.R.call('POST', '/tickets/ask', { idea: 'A radio', repo });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const pm = (await o.R.call('GET', '/terminals')).body.terminals.find((x) => x.id === r.body.terminal);
  fs.writeFileSync(path.join(pm.cwd, 'notes.txt'), 'kept\n');
  await o.R.call('POST', '/terminals/' + pm.id + '/stop', {});
  await p.page.locator('.cc-ask', { hasText: 'Checkout for the PM with nobody in it: ' + pm.cwd }).waitFor();
  assert.deepStrictEqual(p.errors, []);
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
  await p.page.locator('#cards .desk', { hasText: t.who }).waitFor();
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
