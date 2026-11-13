// The room page in a browser (relay/test/browser/page.js), with WebGL off: the Board moves a ticket
// through every column a person moves it to, the Tasks dropdown moves its card, a raised hand shows,
// and How work moves opens the manual.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');
const H = require('../helpers.js');
const { makeRepo, sessionToken, ROOT } = H;
const { office, pageTest, until } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;
// Board, Chat and Tasks start folded on the room page (office/fold.js). Open these.
async function unfold(p, ...ids) {
  for (const id of ids) {
    const b = p.page.locator('#' + id + ' > header h2 .fold');
    if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click();
  }
}

pageTest('the Board has its seven columns, in order', get, async (p) => {
  await p.open(); await unfold(p, 'board');
  const cols = p.page.locator('#board-cols > section');
  await cols.first().waitFor();
  assert.deepStrictEqual(await cols.evaluateAll((s) => s.map((x) => x.dataset.col)), ['triage', 'ready', 'building', 'in_review', 'changes_requested', 'waiting_on_you', 'done']);
  const heads = await p.page.locator('#board-cols h3').allInnerTexts();
  assert.deepStrictEqual(heads.map((h) => h.replace(/ \(\d+\)$/, '')), ['Triage', 'Ready', 'Building', 'In review', 'Changes requested', 'Waiting on you', 'Done']);
});

pageTest('a ticket goes in, out to Rejected, back to Triage, is approved and started, and the Tasks dropdown moves it', get, async (p) => {
  const repo = makeRepo(o.R.home, 'board-repo');
  await p.open(); await unfold(p, 'board', 'tasks');
  const page = p.page;
  const card = (col) => page.locator('#board-cols [data-col="' + col + '"] li', { hasText: 'Radio clips at high volume' });

  await page.fill('#ticket-title', 'Radio clips at high volume');
  await page.fill('#ticket-repo', repo);
  await page.fill('#ticket-body', 'Turn it down.');
  await page.click('#ticket-form button[type=submit]');
  await page.locator('#ticket-note', { hasText: /^Filed T-\d+\.$/ }).waitFor();
  const id = (await page.innerText('#ticket-note')).match(/T-\d+/)[0];
  await card('ready').waitFor();  // a person's ticket needs no approval

  await card('ready').getByRole('button', { name: 'Reject', exact: true }).click();
  await card('ready').waitFor({ state: 'detached' });
  const rejected = page.locator('#board-rejected');
  await rejected.locator('summary', { hasText: 'Rejected (1)' }).waitFor();
  await rejected.locator('summary').click();
  await rejected.locator('li', { hasText: id }).getByRole('button', { name: 'Back to Triage' }).click();

  await card('triage').waitFor();
  assert.strictEqual(await rejected.isHidden(), true, 'nothing is left in Rejected');
  await card('triage').getByRole('button', { name: 'Approve' }).click();
  await card('ready').getByRole('button', { name: 'Start' }).click();
  await card('building').waitFor();

  // Its task, with a worker, on the Tasks panel.
  const row = page.locator('#task-rows li', { hasText: 'Radio clips at high volume' });
  await row.and(page.locator('[data-state="building"]')).waitFor();
  await row.locator('select').selectOption('in_review');
  await row.and(page.locator('[data-state="in_review"]')).waitFor();
  await card('in_review').waitFor();
  const r = await o.R.call('GET', '/tasks');
  assert.strictEqual(r.body.tasks.find((t) => t.ticket === id).state, 'in_review', 'the relay has the move, not only the page');
  assert.deepStrictEqual(p.errors, []);
});

pageTest('a long Ready column folds by priority, closed until you open a group, and stays as you left it', get, async (p) => {
  const repo = makeRepo(o.R.home, 'groups-repo');
  const mine = [];
  for (let i = 0; i < 8; i++) mine.push((await o.R.call('POST', '/tickets', { title: 'Folded ' + i, repo, priority: i < 2 ? 'high' : 'normal' })).body.ticket.id);
  await p.open(); await unfold(p, 'board');
  const page = p.page, ready = page.locator('#board-cols [data-col="ready"]');
  const group = (pr) => ready.locator('details.group[data-priority="' + pr + '"]');
  await group('normal').waitFor();
  assert.match(await group('high').locator(':scope > summary').innerText(), /^High \(\d+\)$/);
  assert.strictEqual(await group('high').evaluate((d) => d.open), false, 'closed at first');
  assert.strictEqual(await ready.locator('li', { hasText: 'Folded 0' }).isVisible(), false);
  await group('high').locator(':scope > summary').click();
  await ready.locator('li', { hasText: 'Folded 0' }).waitFor();
  await until(p, () => (localStorage.getItem('office.boardGroups') || '').includes('ready:high'));  // the browser saves it on its toggle event, a moment after the click
  await page.reload(); await group('high').waitFor({ state: 'attached' });
  await until(p, () => document.querySelector('#board-cols [data-col="ready"] details.group[data-priority="high"]').open);
  assert.strictEqual(await group('normal').evaluate((d) => d.open), false, 'only the one you opened');
  for (const id of mine) await o.R.call('POST', '/tickets/' + id + '/move', { to: 'rejected' });
  assert.deepStrictEqual(p.errors, []);
});

// The Board redraws when anything on it changes, such as a task's pipeline. A redraw keeps where you
// scrolled, and waits while you use a control on a card, so the Board never jumps or takes a picker away.
pageTest('a redraw keeps a column\'s scroll, and waits while you use a card\'s priority picker', get, async (p) => {
  const repo = makeRepo(o.R.home, 'scroll-repo');
  for (let i = 0; i < 30; i++) await o.R.call('POST', '/tickets', { title: 'Scroll test ticket ' + i, body: 'x', repo, priority: i % 3 ? 'normal' : 'high' });
  const page = p.page;
  await page.setViewportSize({ width: 1400, height: 700 });
  await page.goto(o.address.replace('/office/?', '/office/board.html?'));
  const box = page.locator('[data-col="ready"] > .groups');
  await box.waitFor();
  await page.evaluate(() => document.querySelectorAll('[data-col="ready"] details.group').forEach((d) => { d.open = true; }));
  await until(p, () => { const el = document.querySelector('[data-col="ready"] > .groups'); return el.scrollHeight > el.clientHeight + 400; });
  await box.evaluate((el) => { el.scrollTop = 400; });

  await o.R.call('POST', '/tickets', { title: 'Scroll test, a change elsewhere', body: 'x', repo });
  await page.locator('#board-cols li', { hasText: 'Scroll test, a change elsewhere' }).waitFor();
  assert.strictEqual(await box.evaluate((el) => el.scrollTop), 400, 'the column stays where you scrolled it');

  // A picker you are using is not replaced under you. The change shows once you leave it.
  const pick = page.getByLabel(/^Priority of T-/).first();
  await pick.evaluate((el) => { el.dataset.mine = '1'; el.focus(); });
  await o.R.call('POST', '/tickets', { title: 'Scroll test, while you pick', body: 'x', repo });
  await page.waitForTimeout(4500);  // two polls of the Board
  assert.strictEqual(await page.locator('#board-cols li', { hasText: 'Scroll test, while you pick' }).count(), 0, 'no redraw while the picker has focus');
  assert.ok(await page.evaluate(() => document.activeElement && document.activeElement.dataset.mine === '1'), 'the picker is still the one you had');
  await page.evaluate(() => document.activeElement.blur());
  await page.locator('#board-cols li', { hasText: 'Scroll test, while you pick' }).waitFor();
  assert.deepStrictEqual(p.errors, []);
});

// A session files a four-part body on stdin in a quoted heredoc, as its brief says (T-49). Triage shows
// its line breaks, quotes, backticks and $( ) as written, and nothing in it ran.
pageTest('a body filed with ticket.js shows in Triage exactly as written', get, async (p) => {
  const repo = makeRepo(o.R.home, 'body-repo');
  const session = (await o.R.call('POST', '/terminals', { cwd: repo })).body;
  const token = await H.until(() => { try { return sessionToken(session.sessionId); } catch (e) { return null; } }, 'the session\'s token');
  const body = 'What to build: a "quoted" word, a `backtick` and $(echo ran) stay as written.\n\nAcceptance criteria:\n- \'single\' quotes, a \\ backslash and $HOME too\n\nOut of scope: none';
  const env = { ...process.env, OFFICE_TICKET_URL: o.R.base + '/tickets', OFFICE_TICKET_TOKEN: token, CLI: path.join(ROOT, 'relay', 'ticket.js') };
  const out = execFileSync('/bin/sh', ['-c', 'node "$CLI" create "Body as written" --body - <<\'EOF\'\n' + body + '\nEOF\n'], { env, encoding: 'utf8' });
  const id = out.match(/Filed: (\S+)/)[1];
  await p.open(); await unfold(p, 'board');
  const card = p.page.locator('#board-cols [data-col="triage"] li[data-ticket="' + id + '"]');
  await card.locator('summary').click();
  const shown = card.locator('details > p').first();
  assert.strictEqual(await shown.textContent(), body);
  assert.strictEqual(await shown.innerText(), body, 'the line breaks show as line breaks');
  await o.R.call('POST', '/tickets/' + id + '/move', { to: 'rejected' });
  await o.R.call('POST', '/terminals/' + session.id + '/stop', {});
  assert.deepStrictEqual(p.errors, []);
});

// A card shows its kind, and the person changes it there until the ticket starts (T-104).
pageTest('a card shows its kind, and Change kind sets it', get, async (p) => {
  const repo = makeRepo(o.R.home, 'kind-repo');
  const id = (await o.R.call('POST', '/tickets', { title: 'Has a kind', repo, kind: 'docs' })).body.ticket.id;
  await p.open(); await unfold(p, 'board');
  const card = p.page.locator('#board-cols [data-col="ready"] li[data-ticket="' + id + '"]');
  await until(p, (sel) => /kind docs/.test((document.querySelector(sel) || {}).textContent || ''), '#board-cols li[data-ticket="' + id + '"]');
  // Tickets from the tests before this one can fold the Ready column by priority: open its group.
  await p.page.evaluate((sel) => { const g = document.querySelector(sel).parentElement.closest('details'); if (g) g.open = true; }, '#board-cols li[data-ticket="' + id + '"]');
  await card.getByRole('button', { name: 'Change kind' }).click();
  const box = card.getByLabel('Kind of ' + id);
  assert.strictEqual(await box.inputValue(), 'docs');
  await box.fill('bug');
  await card.getByRole('button', { name: 'Save' }).click();
  await until(p, (sel) => /kind bug/.test((document.querySelector(sel) || {}).textContent || ''), '#board-cols li[data-ticket="' + id + '"]');
  assert.strictEqual((await o.R.call('GET', '/tickets/' + id)).body.ticket.kind, 'bug');
  await o.R.call('POST', '/tickets/' + id + '/move', { to: 'rejected' });
  assert.deepStrictEqual(p.errors, []);
});

// The room page gets the Board on its relay stream (relay/board-push.js), so it does not ask for it.
// A change to one ticket replaces that card's element only: the other cards stay the same elements.
pageTest('the relay pushes a change to the room page\'s Board, which replaces only that card and asks for no tickets', get, async (p) => {
  const repo = makeRepo(o.R.home, 'push-repo');
  execFileSync('git', ['branch', 'other'], { cwd: repo });
  const ids = [];
  for (const title of ['Push one', 'Push two', 'Push three']) ids.push((await o.R.call('POST', '/tickets', { title, repo })).body.ticket.id);
  const page = p.page;
  const asked = [];
  page.on('request', (r) => { if (r.method() === 'GET' && new URL(r.url()).pathname === '/channels/t/tickets') asked.push(new Date().toISOString()); });
  await p.open(); await unfold(p, 'board');
  const cardOf = (id) => '#board-cols li[data-ticket="' + id + '"]';
  for (const id of ids) await page.locator(cardOf(id)).waitFor({ state: 'attached' });
  // Mark each card's element, so the test can tell a kept element from a new one.
  await page.evaluate((list) => list.forEach((id) => { document.querySelector('#board-cols li[data-ticket="' + id + '"]').mine = id; }), ids);
  asked.length = 0;  // the page asks once as it loads, before its stream is open

  await o.R.call('POST', '/tickets/' + ids[1] + '/base', { base: 'other' });
  await until(p, (sel) => /base other/.test(document.querySelector(sel).textContent), cardOf(ids[1]));
  const marks = await page.evaluate((list) => list.map((id) => document.querySelector('#board-cols li[data-ticket="' + id + '"]').mine || null), ids);
  assert.deepStrictEqual(marks, [ids[0], null, ids[2]], 'only the changed card is a new element');

  await page.waitForTimeout(11000);  // past the 10 seconds the room page waits between asks when it has no stream
  assert.deepStrictEqual(asked, [], 'no GET /tickets while the stream is open');
  for (const id of ids) await o.R.call('POST', '/tickets/' + id + '/move', { to: 'rejected' });
  assert.deepStrictEqual(p.errors, []);
});

pageTest('Board, Chat and Tasks start folded, a title opens one and it stays open, and going to a ticket opens the Board', get, async (p) => {
  const repo = makeRepo(o.R.home, 'fold-repo');
  const id = (await o.R.call('POST', '/tickets', { title: 'Find me when folded', repo })).body.ticket.id;
  await p.open();
  const page = p.page, folded = (id) => page.locator('#' + id).evaluate((s) => s.hasAttribute('data-folded'));
  await page.locator('#board > header h2 .fold').waitFor();
  assert.deepStrictEqual([await folded('board'), await folded('tasks')], [true, true], 'closed at first');
  for (const part of ['#ticket-form', '#board-cols', '#task-form', '#task-rows', '#chat-posts']) assert.strictEqual(await page.locator(part).isVisible(), false, part + ' is folded away: only the title line shows');
  assert.strictEqual(await page.locator('#board-info').isVisible(), true);
  await page.locator('#tasks > header h2 .fold').click();
  await page.locator('#task-form').waitFor();
  await until(p, () => (localStorage.getItem('office.openSections') || '').includes('tasks'));
  await page.reload(); await page.locator('#tasks > header h2 .fold').waitFor();
  assert.deepStrictEqual([await folded('board'), await folded('tasks')], [true, false], 'only the one you opened stays open');
  await page.evaluate((x) => window.dispatchEvent(new CustomEvent('office:ticket', { detail: { id: x } })), id);
  await page.locator('#board-cols li', { hasText: 'Find me when folded' }).waitFor();
  assert.strictEqual(await page.locator('#board > header h2 .fold').getAttribute('aria-expanded'), 'true');
  assert.ok(!(await page.evaluate(() => localStorage.getItem('office.openSections'))).includes('board'), 'going to a ticket does not keep the Board open');
  await o.R.call('POST', '/tickets/' + id + '/move', { to: 'rejected' });
  assert.deepStrictEqual(p.errors, []);
});

pageTest('a raised hand shows on the Floor and in the title', get, async (p) => {
  await p.open();
  const S = 'hand-' + Date.now();
  await o.R.hook({ hook_event_name: 'SessionStart', session_id: S, project: 'hands' });
  await o.R.hook({ hook_event_name: 'Notification', session_id: S, message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
  await p.page.locator('#people li[data-state="waiting"]', { hasText: 'Claude needs your permission to use Bash' }).waitFor();
  await until(p, () => /^\(1\) /.test(document.title));
  assert.match(await p.page.innerText('#busy'), /1 waiting on you/);
  // The tool runs: the hand comes down, and the title loses its count.
  await o.R.hook({ hook_event_name: 'PostToolUse', session_id: S, tool_name: 'Bash' });
  await until(p, () => !/^\(\d+\) /.test(document.title));
  assert.strictEqual(await p.page.locator('#people li[data-state="waiting"]').count(), 0);
  assert.deepStrictEqual(p.errors, []);
});

pageTest('How work moves opens the manual in a new tab', get, async (p) => {
  await p.open();
  const [tab] = await Promise.all([p.context.waitForEvent('page'), p.page.locator('#board .help-link', { hasText: 'How work moves' }).click()]);
  await tab.waitForLoadState();
  assert.match(tab.url(), /\/docs\/manual\/roles\.html$/);
  assert.match(await tab.title(), /\S/);
  assert.strictEqual(p.page.url(), o.address, 'the room stays open in its own tab');
  assert.deepStrictEqual(p.errors, []);
});

// T-90: Edit on a Triage or Ready card changes its title, body and priority, and its history says so.
pageTest('Edit changes a Ready ticket\'s title, body and priority, and the history shows the edit', get, async (p) => {
  const repo = makeRepo(o.R.home, 'edit-repo');
  await p.open(); await unfold(p, 'board');
  const page = p.page;
  await page.fill('#ticket-title', 'Needs one more link');
  await page.fill('#ticket-repo', repo);
  await page.fill('#ticket-body', 'The first words.');
  await page.click('#ticket-form button[type=submit]');
  await page.locator('#ticket-note', { hasText: /^Filed T-\d+\.$/ }).waitFor();
  const id = (await page.innerText('#ticket-note')).match(/T-\d+/)[0];
  const card = page.locator('#board-cols [data-col="ready"] li[data-ticket="' + id + '"]');
  // Earlier tests leave enough Ready cards to fold the column by priority, so go to the ticket, which opens its group.
  const goTo = () => page.evaluate((x) => window.dispatchEvent(new CustomEvent('office:ticket', { detail: { id: x } })), id);
  await goTo();
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  // The ticket changes while the form is open. Save sends only what you changed, so this title stays.
  assert.strictEqual((await o.R.call('POST', '/tickets/' + id + '/edit', { title: 'Needs one more link, with it' })).status, 200);
  await card.locator('summary', { hasText: 'Needs one more link, with it' }).waitFor({ state: 'attached' });
  assert.strictEqual(await card.getByLabel('Title of ' + id).inputValue(), 'Needs one more link', 'what is typed stays');
  await card.getByLabel('Body of ' + id).fill('The first words. See https://example.com/x');
  await card.getByLabel('Priority of ' + id + ' in the edit').selectOption('high');
  await card.getByRole('button', { name: 'Save' }).click();
  await card.getByLabel('Title of ' + id).waitFor({ state: 'detached' });  // the form closes once saved
  await card.locator('summary', { hasText: 'Needs one more link, with it' }).waitFor({ state: 'attached' });
  assert.strictEqual(await card.getAttribute('data-priority'), 'high');
  await goTo();  // now in the High group
  await card.locator('p', { hasText: 'See https://example.com/x' }).waitFor();
  await card.locator('.th-steps li', { hasText: 'Edited (body, priority) by you' }).waitFor();
});

// Labels sort a long Board. The person sets them on a card, and the tab folds Triage and Ready by label,
// and filters by one. The fold is kept in this browser, so a reload keeps it.
pageTest('a card takes labels, and the tab folds and filters by label', get, async (p) => {
  const repo = makeRepo(o.R.home, 'label-repo');
  const ids = [];
  for (let i = 0; i < 7; i++) ids.push((await o.R.call('POST', '/tickets', { title: 'Label test ticket ' + i, body: 'x', repo, labels: i < 2 ? ['flaky'] : [] })).body.ticket.id);
  const page = p.page;
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(o.address.replace('/office/?', '/office/board.html?'));
  await page.locator('#board-filter-repo option[value="' + repo + '"]').waitFor({ state: 'attached' });
  await page.selectOption('#board-filter-repo', repo);
  const card = page.locator('[data-col="ready"] li[data-ticket="' + ids[2] + '"]').first();
  await card.getByRole('button', { name: 'Labels' }).click();
  await page.getByLabel('Labels of ' + ids[2]).fill('Flaky, ci');
  await card.getByRole('button', { name: 'Save' }).click();
  await page.locator('[data-col="ready"] li[data-ticket="' + ids[2] + '"] small', { hasText: 'labels flaky, ci' }).first().waitFor();

  await page.selectOption('#board-group-by', 'label');
  const groups = () => page.locator('[data-col="ready"] details.group > summary').allInnerTexts();
  await until(p, () => [...document.querySelectorAll('[data-col="ready"] details.group')].some((d) => d.dataset.group === 'label:ci'));
  assert.deepStrictEqual(await groups(), ['ci (1)', 'flaky (3)', 'No label (4)'], 'one group per label, A to Z, then No label');
  assert.strictEqual(await page.locator('[data-col="ready"] li[data-ticket="' + ids[2] + '"]').count(), 2, 'a ticket with two labels is in both groups');

  await page.selectOption('#board-filter-label', 'ci');
  await until(p, () => /^Ready \(1 of \d+\)$/.test(document.querySelector('[data-col="ready"] h3').textContent));
  await page.selectOption('#board-filter-label', '-');
  await until(p, () => /^Ready \(4 of \d+\)$/.test(document.querySelector('[data-col="ready"] h3').textContent));

  await page.reload();
  assert.strictEqual(await page.locator('#board-group-by').inputValue(), 'label', 'the fold is kept in this browser');
  // The room page's Board has the same picker, and shares the pick.
  await p.open(); await unfold(p, 'board');
  assert.strictEqual(await page.locator('#board-group-by').inputValue(), 'label', 'the room page shares the pick');
  await page.locator('[data-col="ready"] details.group[data-group="label:ci"]').waitFor({ state: 'attached' });
  if (process.env.LABEL_SHOT) await page.locator('#board').screenshot({ path: process.env.LABEL_SHOT });
  await page.selectOption('#board-group-by', 'priority');
  await page.locator('[data-col="ready"] details.group[data-group="normal"]').waitFor({ state: 'attached' });
  await page.evaluate(() => { try { localStorage.removeItem('office.boardGroupBy'); } catch (e) { /* no storage */ } });
  for (const id of ids) await o.R.call('POST', '/tickets/' + id + '/move', { to: 'rejected' });
  assert.deepStrictEqual(p.errors, []);
});
