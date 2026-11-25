// The Needs you panel on the Floor (office/needs-you.js; page.js, WebGL off): it says plainly when nothing
// needs the person, shows the count and a line for each thing that does, and a click opens that session.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeRepo, sleep } = require('../helpers.js');
const { office, pageTest } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());

pageTest('Needs you shows the count and the list, and opens the session', () => o, async (p) => {
  const { R } = o;
  const repo = makeRepo(R.home, 'needs-repo');
  const start = async () => (await R.call('POST', '/terminals', { cwd: repo })).body;
  const hook = async (s, event) => { await R.hook({ session_id: s.sessionId.slice(0, 12), ...event }); await sleep(150); };
  const finish = async (s) => { await hook(s, { hook_event_name: 'UserPromptSubmit', title: '' }); await hook(s, { hook_event_name: 'Stop' }); };

  await p.open();
  const { page } = p;
  await page.locator('#needs-you:not([hidden])').waitFor();
  assert.strictEqual(await page.innerText('#needs-you-title'), 'Needs you');
  assert.strictEqual(await page.innerText('#needs-you-count'), '0');
  assert.strictEqual(await page.innerText('#needs-you-empty'), 'Nothing needs you now.');
  assert.strictEqual(await page.locator('#needs-you-list li').count(), 0);
  assert.ok(await page.evaluate(() => document.getElementById('seats').compareDocumentPosition(document.getElementById('needs-you')) & Node.DOCUMENT_POSITION_FOLLOWING), 'Needs you sits under the seats');
  assert.ok(await page.evaluate(() => document.getElementById('needs-you').compareDocumentPosition(document.getElementById('today')) & Node.DOCUMENT_POSITION_FOLLOWING), 'and above Today');

  const asker = await start(), other = await start();
  await finish(asker); await finish(other);
  await hook(asker, { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
  const who = (await R.call('GET', '/terminals')).body.terminals.find((t) => t.id === asker.id).who;

  const line = page.locator('#needs-you-list li[data-kind="permission"] .needs-line');
  await line.waitFor();
  assert.strictEqual(await page.innerText('#needs-you-count'), '1');
  assert.strictEqual(await page.locator('#needs-you-empty').isVisible(), false);
  assert.strictEqual(await line.innerText(), 'Approve or deny the request from ' + who + ': Claude needs your permission to use Bash');

  await line.click();
  await page.locator('#cc-status', { hasText: 'session ' + asker.sessionId.slice(0, 8) }).waitFor();

  await hook(asker, { hook_event_name: 'PreToolUse', tool_name: 'Bash' });
  await page.locator('#needs-you-empty:not([hidden])').waitFor();
  assert.strictEqual(await page.innerText('#needs-you-count'), '0');
  assert.deepStrictEqual(p.errors, []);
});

pageTest('a line about a GitHub issue opens its ticket, whose id is the bare issue number', () => o, async (p) => {
  await p.open();
  const { page } = p;
  const item = { kind: 'ticket-write', who: 'the relay', terminal: null, task: null, ticket: '68', pr: null, line: 'Fix what stops a GitHub write: the relay could not close issue #68. GitHub says: Bad. It tries again in 4 minutes.', link: { ticket: '68' } };
  await page.route(/\/needs-you(\?|$)/, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, at: new Date().toISOString(), count: 1, items: [item] }) }));
  await page.evaluate(() => window.addEventListener('office:ticket', (ev) => { window.openedTicket = ev.detail.id; }));
  const line = page.locator('#needs-you-list li[data-kind="ticket-write"] button.needs-line');
  await line.waitFor();
  assert.strictEqual(await line.getAttribute('title'), 'Show 68 on the Board');
  await line.click();
  await page.waitForFunction(() => window.openedTicket === '68');
  await page.unroute(/\/needs-you(\?|$)/);
});
