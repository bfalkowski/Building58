// The front office and the workers row on the room page (office/front-view.js), with WebGL off and the relay's
// Floor, Needs you, Board and numbers answered by the test, so each state is one the test chose: the Lead and
// PM and manager seats, a worker card that says "PR not started" until its PR opens and then pairs its Dev with the
// reviewer of that PR, links to the ticket and the PR, Up next with the PM's verdicts, and a card that waits on
// the person or is stuck, with a steady light that pulses once when it enters the state.
'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { sleep, until } = require('../helpers.js');
const { office, pageTest } = require('./page.js');

let o;
test.before(async () => { o = await office(); });
test.after(() => o && o.stop());
const get = () => o;

const PR = 'https://github.com/acme/widgets/pull/378';
const desk = (over) => Object.assign({ ticket: null, title: null, column: null, pr: null, prNumber: null, ci: null, ciWords: null, review: null, rounds: 0, doing: { state: 'working', words: 'working' }, status: null, next: null, stop: { safe: false, reason: null } }, over);
const row = (over, d) => Object.assign({ terminal: 'x', name: 'X', named: true, role: 'session', seat: null, ticket: null, title: null, pr: null, state: 'working', safe: false, canStop: false, why: '', desk: desk(d), tired: null }, over);
const LEAD = row({ terminal: 'aaaaaaaaaaaa', name: 'Paul', role: 'Lead', seat: 'lead', tired: { key: 'fresh', icon: '✅', label: 'fresh', percent: 12 } }, { next: { text: 'The Lead keeps tickets moving', owner: 'Lead' } });
const PM = row({ terminal: 'bbbbbbbbbbbb', name: 'Priya', role: 'PM', seat: 'pm' }, { doing: { state: 'idle', words: 'idle 3 min' }, next: { text: 'Waiting on you: talk tickets through with the PM', owner: 'you' } });
const MANAGER = row({ terminal: 'eeeeeeeeeeee', name: 'Mo', role: 'Manager', seat: 'manager' }, { doing: { state: 'idle', words: 'idle 1 min' }, next: { text: 'The manager watches the room and files tickets for what keeps jamming it', owner: 'Manager' } });
const dev = (over, d) => row(Object.assign({ terminal: 'cccccccccccc', name: 'Bea', role: 'Dev', ticket: '293', title: 'Workers add notes' }, over), Object.assign({ ticket: '293', column: { id: 'building', label: 'Building' } }, d));
const reviewer = () => row({ terminal: 'dddddddddddd', name: 'Farah', role: 'reviewer', pr: PR }, { pr: PR, prNumber: '#378', review: 'review running', reviewing: { pr: PR, prNumber: '#378', dev: { terminal: 'cccccccccccc', name: 'Bea' } } });

const ready = (id, title, priority, extra) => Object.assign({ id, title, body: '', status: 'ready', repo: '/r', approved: true, waitingFor: [], rejectedBlockers: [], blockedBy: [], labels: [], notes: [], heldBack: null, task: null, priority, history: [], createdAt: '2026-11-24T10:00:00.000Z' }, extra);
const advice = (answer, why, of) => [{ stage: 'pm-advice', answer, why, of: of || null }];
const BOARD = {
  ok: true, store: 'local',
  tickets: [
    ready('360', 'A PR found by its branch gets its first review', 'high', { history: advice('start', 'Still needed, nothing on main does it.') }),
    ready('361', 'Autopilot brings back a stopped Dev', 'high', { history: advice('first', '361 keeps the room working.', '362') }),
    ready('214', 'The manager as a real session', 'normal'),
    ready('215', 'An elevator to the executive floor', 'normal', { heldBack: 'Waits on you.', proposal: { action: 'close', ids: ['214'], why: 'Ticket 214 covers the same work.', by: 'PM' } }),
    ready('346', 'Clear a wrong relay key cookie', 'low', { history: advice('duplicate', 'Same as 360.', '360') }),
    ready('400', 'A sixth ticket', 'low'),
    ready('401', 'A seventh ticket', 'low')
  ]
};

pageTest('the front office has the Lead and PM seats, and Up next lists Ready tickets with the PM\'s verdicts', get, async (p) => {
  const page = p.page;
  await page.route(/\/channels\/t\/floor$/, (route) => route.fulfill({ json: { ok: true, sessions: [LEAD, PM, MANAGER], manager: { level: 3, levelName: 'The Lead starts tickets', lowersTrust: true, lastLowered: { at: '2026-11-25T10:30:00.000Z', from: 4, to: 3 }, watching: { kind: 'flake-blocks', label: 'Flaky test blocks', ticket: '77', fixed: true, outcome: { before: 4, after: 1, down: true, words: 'The fix merged. Jams of this kind: 4 a day before, 1 a day since, so it went down.' } }, coo: { running: false, last: '2026-11-24T09:15:00.000Z' } }, pm: { trust: 2, trustName: 'Hold and propose', sortHours: 4, nextSortAt: new Date(Date.now() + 3 * 3600000 + 40 * 60000).toISOString() }, leadEnded: null, mainRed: [] } }));
  await page.route(/\/channels\/t\/metrics\?range=1d/, (route) => route.fulfill({ json: { ok: true, numbers: { merged: 5, medianMinutes: 290 } } }));
  await p.open();
  const lead = page.locator('#seats .seat[data-seat="lead"]'), pm = page.locator('#seats .seat[data-seat="pm"]');
  await lead.waitFor();
  await pm.waitFor();
  assert.match(await lead.innerText(), /Lead[\s\S]*always on[\s\S]*Paul/);
  assert.match(await lead.innerText(), /Fresh/, 'how tired the Lead is');
  assert.match(await pm.innerText(), /trust: 2 Hold and propose/);
  assert.match(await pm.innerText(), /Next sort in 3 h/);
  assert.strictEqual(await page.locator('#seats .seat').count(), 3, 'the Lead, the PM and the manager');
  const manager = page.locator('#seats .seat[data-seat="manager"]');
  const text = await manager.innerText();
  assert.match(text, /Manager[\s\S]*always on[\s\S]*Mo/);
  assert.match(text, /trust: 3 The Lead starts tickets/, 'the trust level');
  assert.match(text, /Lowered the trust level from 4 to 3 at /, 'the last time it lowered it');
  assert.match(text, /Watching: Flaky test blocks jams, ticket 77\. The fix merged\. Jams of this kind: 4 a day before, 1 a day since, so it went down\./, 'the cause and whether the count went down');
  assert.match(text, /Last COO report /, 'the COO\'s last report');
  assert.strictEqual(await manager.getAttribute('data-state'), '', 'no mark while it is neither stuck nor waiting');
  assert.strictEqual(await manager.locator('button[data-coo="ask"]').innerText(), 'Ask the COO');
  assert.ok((await page.locator('#front-office').boundingBox()).y > (await page.locator('#stage').boundingBox()).y, 'the front office is under the 3D office');
  assert.ok((await page.locator('#workers').boundingBox()).y > (await page.locator('#front-office').boundingBox()).y, 'the workers row is under it');

  await page.evaluate((b) => window.dispatchEvent(new CustomEvent('office:tickets', { detail: b })), BOARD);
  const items = page.locator('#up-next-list li');
  await items.nth(4).waitFor();
  assert.strictEqual(await items.count(), 5, 'the next 5');
  assert.deepStrictEqual(await items.evaluateAll((lis) => lis.map((li) => li.dataset.ticket)), ['360', '361', '214', '215', '346'], 'in Autopilot\'s order');
  const verdicts = await items.evaluateAll((lis) => lis.map((li) => li.querySelector('.verdict').textContent));
  assert.deepStrictEqual(verdicts, ['✓ start', '↓ after 362', 'not checked yet', '✕ close 214 proposed, waits on you', '✕ duplicate 360']);
  assert.match(await items.nth(0).locator('.verdict').getAttribute('title'), /^PM: Still needed/);
  assert.strictEqual(await items.nth(3).getAttribute('class'), 'you', 'a proposal that waits on you has the mark');
  assert.strictEqual(await items.nth(3).locator('button', { hasText: 'Approve' }).count(), 1, 'and an approve link');
  assert.strictEqual(await items.nth(0).locator('button', { hasText: 'Approve' }).count(), 0);
  assert.match(await page.locator('#up-next-more').innerText(), /2 more in Ready/);
  assert.match(await page.locator('#today').innerText(), /5 merged · median 4 h 50 min per ticket · 0 wait on you · 6 of 6 desks free/);
  const href = await items.nth(0).locator('a').first().getAttribute('href');
  assert.strictEqual(href, 'board.html?channel=t&ticket=360');
  assert.strictEqual(await items.nth(0).locator('a').first().getAttribute('target'), '_blank');
  await page.evaluate((b) => window.dispatchEvent(new CustomEvent('office:tickets', { detail: b })), Object.assign({}, BOARD, { store: 'github' }));
  await page.waitForFunction(() => /github\.com\/.+\/issues\/360$/.test(document.querySelector('#up-next-list li a').href) || document.querySelector('#up-next-list li a').href.includes('board.html'));
  assert.deepStrictEqual(p.errors, []);
});

pageTest('a worker card says PR not started, then its PR, and holds the reviewer of that PR', get, async (p) => {
  const page = p.page;
  let sessions = [LEAD, PM, dev()];
  await page.route(/\/channels\/t\/floor$/, (route) => route.fulfill({ json: { ok: true, sessions, pm: null, leadEnded: null, mainRed: [] } }));
  await p.open();
  const card = page.locator('#cards .pair[data-card="cccccccccccc"]');
  await card.waitFor();
  assert.strictEqual(await card.locator('.pair-cap').innerText(), 'Ticket 293 · PR not started · building');
  assert.match(await card.innerText(), /no reviewer yet/);
  assert.strictEqual(await card.locator('.pair-cap a').count(), 1, 'only the ticket is a link before the PR opens');
  assert.strictEqual(await card.locator('.pair-cap a').getAttribute('href'), 'board.html?channel=t&ticket=293');
  assert.match(await page.locator('#workers-meta').innerText(), /1 worker on 1 ticket · 0 reviewers · 5 desks free/);
  assert.strictEqual(await page.locator('#cards .desk.free').count(), 5, 'the free desks are drawn');

  sessions = [LEAD, PM, dev({ pr: PR }, { pr: PR, prNumber: '#378', column: { id: 'in_review', label: 'In review' }, rounds: 0 }), reviewer()];
  await card.locator('.pair-cap', { hasText: 'PR #378' }).waitFor();
  assert.strictEqual(await card.locator('.pair-cap').innerText(), 'Ticket 293 · PR #378 · in review');
  const pr = card.locator('.pair-cap a', { hasText: '#378' });
  assert.strictEqual(await pr.getAttribute('href'), PR);
  assert.strictEqual(await pr.getAttribute('target'), '_blank');
  assert.match(await card.innerText(), /Farah[\s\S]*Reviewer/, 'the reviewer of that PR is in the same card');
  assert.strictEqual(await page.locator('#cards .pair').count(), 1, 'one card for the ticket');

  sessions = [LEAD, PM, dev({ pr: PR }, { pr: PR, prNumber: '#378', column: { id: 'changes_requested', label: 'Changes requested' }, rounds: 1, status: { key: 'fix', icon: 'x', label: 'fix requested' } })];
  await card.locator('.pair-cap', { hasText: 'changes requested, round 2 next' }).waitFor();
  assert.match(await card.innerText(), /reviewer left its desk[\s\S]*last verdict: fix/, 'the slot keeps the last verdict');
  assert.deepStrictEqual(p.errors, []);
});

pageTest('a card that waits on you, or is stuck, has a steady light and one pulse, and loses them when it clears', get, async (p) => {
  const page = p.page;
  let sessions = [LEAD, PM, dev({ pr: PR }, { pr: PR, prNumber: '#378', column: { id: 'in_review', label: 'In review' } })];
  let needs = [];
  await page.route(/\/channels\/t\/floor$/, (route) => route.fulfill({ json: { ok: true, sessions, pm: null, leadEnded: null, mainRed: [] } }));
  await page.route(/\/channels\/t\/needs-you$/, (route) => route.fulfill({ json: { ok: true, count: needs.length, items: needs } }));
  await page.addInitScript(() => {
    window.starts = {};
    document.addEventListener('animationstart', (e) => { const k = (e.target.closest('[data-card],[data-seat]') || e.target); const id = k.dataset.card || k.dataset.seat || e.target.className; window.starts[id] = (window.starts[id] || 0) + 1; }, true);
  });
  await p.open();
  const card = page.locator('#cards .pair[data-card="cccccccccccc"]');
  await card.waitFor();
  await sleep(2500);
  assert.strictEqual(await card.getAttribute('data-state'), '');
  assert.strictEqual(await card.locator('.lamp').count(), 0);

  needs = [{ kind: 'merge', who: 'Bea', terminal: 'cccccccccccc', task: 'k1', ticket: '293', pr: PR, line: 'Merge PR 378 yourself: it changes the constitution.', link: { url: PR } }];
  await page.locator('#needs-you-list li').waitFor();
  assert.match(await page.locator('#needs-you-list li').innerText(), /Ticket 293/);
  assert.strictEqual(await page.locator('#needs-you-list li a', { hasText: 'PR #378' }).getAttribute('href'), PR);
  assert.strictEqual(await page.locator('#needs-you-list li a', { hasText: 'Ticket 293' }).getAttribute('target'), '_blank');
  await card.locator('.lamp[data-lamp="wait"]').waitFor();
  assert.strictEqual(await card.getAttribute('data-state'), 'wait');
  assert.strictEqual((await card.locator('.pair-cap').innerText()).split(' · ')[0], 'Waits on you: merge', 'the reason comes first');
  assert.match(await card.locator('.pair-cap').innerText(), /^Waits on you: merge · Ticket 293 · PR #378$/);
  assert.strictEqual(await page.locator('#needs-you-count').innerText(), '1', 'Needs you agrees');
  assert.strictEqual(await card.evaluate((c) => getComputedStyle(c).boxShadow.includes('inset') || getComputedStyle(c).borderLeftColor !== ''), true);
  await sleep(4500);
  assert.strictEqual(await page.evaluate(() => window.starts.cccccccccccc), 1, 'one pulse when it entered the state, and none after');

  needs = [];
  await card.locator('.lamp').waitFor({ state: 'detached' });
  assert.strictEqual(await card.getAttribute('data-state'), '');

  sessions = [LEAD, PM, dev({ pr: null }, { doing: { state: 'stuck', words: 'stuck: told 27 min ago, did not start' } })];
  await card.locator('.lamp[data-lamp="stuck"]').waitFor();
  assert.match(await card.locator('.pair-cap').innerText(), /^Stuck: told 27 min ago, did not start · Ticket 293 · PR not started · building$/);
  await sleep(4500);
  assert.strictEqual(await page.evaluate(() => window.starts.cccccccccccc), 2, 'one more pulse for the new state, and no more');
  assert.deepStrictEqual(p.errors, []);
});

pageTest('with reduced motion nothing pulses, and on a narrow screen the page stacks in one column', get, async (p) => {
  const page = p.page;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let sessions = [LEAD, PM, dev()];
  await page.route(/\/channels\/t\/floor$/, (route) => route.fulfill({ json: { ok: true, sessions, pm: null, leadEnded: null, mainRed: [] } }));
  await page.route(/\/channels\/t\/needs-you$/, (route) => route.fulfill({ json: { ok: true, count: 1, items: [{ kind: 'question', who: 'Bea', terminal: 'cccccccccccc', ticket: '293', pr: null, line: 'Bea asks a question.', link: {} }] } }));
  await page.addInitScript(() => { window.started = 0; document.addEventListener('animationstart', (e) => { if (/pulse/.test(e.animationName)) window.started++; }, true); });
  await p.open();
  const card = page.locator('#cards .pair[data-card="cccccccccccc"]');
  await card.waitFor();
  await card.locator('.lamp[data-lamp="wait"]').waitFor();
  await sleep(1500);
  assert.strictEqual(await page.evaluate(() => window.started), 0);
  sessions = [LEAD, PM, dev({ name: 'Ben' })];
  await page.setViewportSize({ width: 600, height: 900 });
  const xs = await page.evaluate(() => ['stage', 'front-office', 'workers'].map((id) => Math.round(document.getElementById(id).getBoundingClientRect().left)));
  assert.strictEqual(new Set(xs).size, 1, 'the 3D office, the front office and the workers row share one column');
  assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no sideways scroll');
  assert.deepStrictEqual(p.errors, []);
});

pageTest('the manager seat shows its state, and the waits-on-you and stuck marks, and the COO button starts a COO', get, async (p) => {
  const page = p.page;
  let manager = MANAGER, needs = [];
  const asked = [];
  await page.route(/\/channels\/t\/floor$/, (route) => route.fulfill({ json: { ok: true, sessions: [LEAD, PM, manager], manager: { level: 1, levelName: 'Review loop', lowersTrust: false, lastLowered: null, watching: null, coo: { running: false, last: null } }, pm: null, leadEnded: null, mainRed: [] } }));
  await page.route(/\/channels\/t\/needs-you$/, (route) => route.fulfill({ json: { ok: true, count: needs.length, items: needs } }));
  await page.route(/\/channels\/t\/officers\/coo\/ask$/, (route) => { asked.push(route.request().method()); route.fulfill({ json: { ok: true, terminal: 'ffffffffffff' } }); });
  await p.open();
  const seat = page.locator('#seats .seat[data-seat="manager"]');
  await seat.waitFor();
  assert.strictEqual(await seat.locator('.dot').getAttribute('data-dot'), 'idle');
  assert.match(await seat.innerText(), /trust: 1 Review loop/);
  assert.match(await seat.innerText(), /It may not lower the trust level\./);
  assert.match(await seat.innerText(), /No COO report yet\./);
  assert.strictEqual(await page.locator('#seats .seat').count(), 3);

  manager = row({ terminal: 'eeeeeeeeeeee', name: 'Mo', role: 'Manager', seat: 'manager' }, { doing: { state: 'working', words: 'working' } });
  await seat.locator('.dot[data-dot="work"]').waitFor();

  needs = [{ kind: 'manager-note', who: 'Manager', terminal: 'eeeeeeeeeeee', task: null, ticket: null, pr: null, line: 'The manager saw a stall: Autopilot gave 3 tasks to you.', link: {} }];
  await seat.locator('.lamp[data-lamp="wait"]').waitFor();
  assert.strictEqual(await seat.getAttribute('data-state'), 'wait');
  assert.match(await seat.innerText(), /Waits on you/);

  needs = [{ kind: 'stuck', who: 'Mo', terminal: 'eeeeeeeeeeee', task: null, ticket: null, pr: null, line: 'Open the session of Mo: no hook for 20 min.', link: { terminal: 'eeeeeeeeeeee' } }];
  await seat.locator('.lamp[data-lamp="stuck"]').waitFor();
  assert.strictEqual(await seat.getAttribute('data-state'), 'stuck');
  assert.match(await seat.innerText(), /Stuck: /);

  await seat.locator('button[data-coo="ask"]').click();
  await until(() => asked.length === 1, 'the click to ask the COO');
  assert.deepStrictEqual(asked, ['POST']);
  assert.deepStrictEqual(p.errors, []);
});
