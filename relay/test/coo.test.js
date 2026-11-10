// The COO (relay/coo.js): the measures the relay keeps for its report, the session that writes it,
// and the report that stays after the session has gone.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, until, sessionToken } = require('./helpers.js');

const CLI = path.join(__dirname, '..', 'ticket.js');
const tokenFor = (s) => until(() => { try { return { 'X-Office-Token': sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'the session');
const at = (h, m) => '2026-11-03T' + String(h).padStart(2, '0') + ':' + String(m || 0).padStart(2, '0') + ':00.000Z';
const moved = (when, from, to, by, note) => ({ at: when, type: 'moved', from, to, by, note });

// Made-up tasks, each with its ticket on the Board. A run ships when its PR merges, and only a stuck
// room counts against it: review rounds are the room working (T-158).
const PR = (n) => 'https://github.com/o/r/pull/' + n;
function task(id, ticket, title, state, history, extra) {
  return Object.assign({ id, title, brief: '', briefed: true, by: 'you', ticket, ticketAt: at(8), state, repo: '/nowhere', base: 'main', branch: 'task/' + id, worktree: '/nowhere/' + id, pr: null, round: 0, owner: null,
    createdAt: history[0].at, updatedAt: history[history.length - 1].at, history }, extra || {});
}
const TASKS = [
  // A bug that review sent back once, which its Dev fixed, and which merged with no step-in: success.
  task('aaaaa1', 'T-1', 'Fix the radio clipping at high volume', 'done', [
    { at: at(9), type: 'created', to: 'building', by: 'you' }, { at: at(9, 30), type: 'pr', pr: PR(1) },
    moved(at(10), 'building', 'changes_requested', 'relay'), { at: at(10, 50), type: 'merged', pr: PR(1) }, moved(at(11), 'changes_requested', 'done', 'you')
  ], { pr: PR(1), reviews: { seen: ['r1', 'c2', 'c3'], own: [], comments: 3, blocking: 1, countedSince: at(9) } }),
  // Docs, done before the relay kept merge times: it merged when it moved to Done. Success.
  task('aaaaa2', 'T-2', 'Docs for the Board columns', 'done', [
    { at: at(9), type: 'created', to: 'building', by: 'you' }, { at: at(9, 20), type: 'pr', pr: PR(2) }, moved(at(10), 'building', 'done', 'Lead')
  ], { pr: PR(2), reviews: { seen: ['r9', 'c9'], own: [] } }),
  // A feature the person moved to Waiting on you for half an hour, then merged: it needed the person.
  task('aaaaa3', 'T-3', 'A switch for the radio', 'done', [
    { at: at(12), type: 'created', to: 'building', by: 'you' }, { at: at(12, 10), type: 'pr', pr: PR(3) }, moved(at(12, 30), 'building', 'waiting_on_you', 'you'),
    moved(at(13), 'waiting_on_you', 'building', 'you'), { at: at(13, 50), type: 'merged', pr: PR(3) }, moved(at(14), 'building', 'done', 'you')
  ], { pr: PR(3) }),
  // Tests whose brief never went in: stuck, and still stuck.
  task('aaaaa4', 'T-4', 'Tests for the huddle timer', 'building', [
    { at: at(15), type: 'created', to: 'building', by: 'you' }, { at: at(15, 10), type: 'note', note: 'The brief was not delivered: the session ended.' }
  ]),
  // Its PR merged and its card stayed in Building, as with T-74: it shipped, with no step-in.
  task('aaaaa5', 'T-5', 'A clock on the wall', 'building', [
    { at: at(9), type: 'created', to: 'building', by: 'Autopilot' }, { at: at(9, 40), type: 'pr', pr: PR(5) }, { at: at(11), type: 'merged', pr: PR(5) }
  ], { pr: PR(5) }),
  // Autopilot sent it to Waiting on you because its reviewer never got its brief, for 45 minutes: stuck.
  task('aaaaa6', 'T-6', 'A lamp on each desk', 'done', [
    { at: at(12), type: 'created', to: 'building', by: 'Autopilot' }, { at: at(12, 20), type: 'pr', pr: PR(6) },
    moved(at(12, 30), 'building', 'in_review', 'Autopilot'),
    moved(at(13), 'in_review', 'waiting_on_you', 'Autopilot', 'Autopilot: Its reviewer Ada has not started on its brief for 30 minutes. The session is still open at its desk: look at it there.'),
    moved(at(13, 45), 'waiting_on_you', 'in_review', 'Autopilot', 'Autopilot: Ada moved again, so the task is back.'), { at: at(14), type: 'merged', pr: PR(6) }, moved(at(14), 'in_review', 'done', 'Autopilot')
  ], { pr: PR(6) }),
  // Its reviewer did not start on its prompt for 20 minutes (relay/delivery.js), and it is not merged yet: stuck.
  task('aaaaa7', 'T-7', 'A plant by the window', 'in_review', [
    { at: at(12), type: 'created', to: 'building', by: 'Autopilot' }, { at: at(12, 20), type: 'pr', pr: PR(7) }, moved(at(12, 30), 'building', 'in_review', 'Autopilot')
  ], { pr: PR(7) }),
  // The person pressed Get a review and Bring back. The relay bringing it back after a restart is not them.
  task('aaaaa8', 'T-8', 'A rug under the table', 'done', [
    { at: at(9), type: 'created', to: 'building', by: 'Autopilot' }, { at: at(9, 10), type: 'pr', pr: PR(8) }, { at: at(9, 15), type: 'resumed', by: 'relay' },
    { at: at(9, 20), type: 'review_asked', by: 'you' }, { at: at(9, 30), type: 'resumed', by: 'you' }, { at: at(10), type: 'merged', pr: PR(8) }, moved(at(10), 'building', 'done', 'Autopilot'),
    { at: at(10, 30), type: 'resumed', by: 'you' }  // after the merge, so not part of the run
  ], { pr: PR(8) }),
  // Autopilot handed it to the person, who merged it on GitHub, and Autopilot moved the card to Done: stuck,
  // and a step-in, though Autopilot made the next move (review of PR 129).
  task('aaaaa9', 'T-9', 'A fan over the bar', 'done', [
    { at: at(9), type: 'created', to: 'building', by: 'Autopilot' }, { at: at(9, 10), type: 'pr', pr: PR(9) },
    moved(at(9, 30), 'building', 'waiting_on_you', 'Autopilot', 'Autopilot: Autopilot has had 2 rounds of review that still say fix. You decide.'),
    { at: at(10, 30), type: 'merged', pr: PR(9) }, moved(at(10, 31), 'waiting_on_you', 'done', 'Autopilot', 'PR 9 merged.')
  ], { pr: PR(9) })
];
const EVENTS = [{ kind: 'not_started', terminal: 'r7', who: 'Bo', task: null, pr: PR(7), at: at(13), endedAt: at(13, 20), ended: 'started at last', detail: 'it was at a menu' }];
// Some tickets carry a kind (T-104): a clock on the wall is docs work by its kind, though its title
// says feature, the huddle timer's tests are a kind the person added, and the plant is set to what the
// guess would say. The rest have none, so the measures guess from the title.
const KIND_OF = { 'T-4': 'chore', 'T-5': 'docs', 'T-7': 'feature' };
const TICKETS = { t: { next: 10, tickets: TASKS.map((x, i) => Object.assign({ id: x.ticket, title: x.title, body: '', status: x.state === 'done' ? 'done' : 'started', priority: 'normal', repo: '/nowhere', base: 'main', blockedBy: [], createdBy: 'you', createdAt: at(8), updatedAt: at(8 + i) }, KIND_OF[x.ticket] ? { kind: KIND_OF[x.ticket] } : {})) } };

function seeded() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-coo-')));
  fs.mkdirSync(path.join(home, '.office-world'), { recursive: true });
  fs.writeFileSync(path.join(home, '.office-world', 'tasks.json'), JSON.stringify({ t: TASKS }));
  fs.writeFileSync(path.join(home, '.office-world', 'tickets.json'), JSON.stringify(TICKETS));
  fs.writeFileSync(path.join(home, '.office-world', 'coo.json'), JSON.stringify({ t: { hands: [], events: EVENTS, reports: [] } }));
  return home;
}

test('the measures for a few made-up tasks', async (t) => {
  const home = seeded();
  const R = await relay({}, home);
  t.after(async () => { await R.kill(); await R.remove(); });

  // A session raises its hand and the person answers it: the relay keeps that hand.
  const s = (await R.call('POST', '/terminals', { cwd: home })).body;
  const sid = s.sessionId.slice(0, 12);
  await R.hook({ hook_event_name: 'Notification', session_id: sid, message: 'Claude needs your permission to use Bash' });
  await R.hook({ hook_event_name: 'PreToolUse', session_id: sid, tool_name: 'Bash' });

  const r = await R.call('GET', '/coo/measures');
  assert.strictEqual(r.status, 200);
  const m = r.body.measures;
  console.log(JSON.stringify(m, null, 2));  // what the COO reads, for the PR

  const run = (ticket) => m.runs.find((x) => x.ticket === ticket);

  // Shipped is a merged PR, by its merge time, with or without its card in Done (T-158).
  assert.deepStrictEqual(m.shipped.map((x) => [x.ticket, x.at, x.card]).sort(), [
    ['T-1', at(10, 50), 'done'], ['T-2', at(10), 'done'], ['T-3', at(13, 50), 'done'], ['T-5', at(11), 'building'], ['T-6', at(14), 'done'], ['T-8', at(10), 'done'], ['T-9', at(10, 30), 'done']
  ]);
  // Review rounds are information: T-1 was sent back once, fixed it, and merged with no step-in.
  assert.strictEqual(run('T-1').outcome, 'success');
  assert.strictEqual(run('T-1').reviewRounds, 1);
  assert.deepStrictEqual(run('T-1').steps, []);
  assert.strictEqual(run('T-5').outcome, 'success', 'merged with its card in Building');
  // The person stepped in: what they did, and how long the room waited.
  assert.strictEqual(run('T-3').outcome, 'manual');
  assert.deepStrictEqual(run('T-3').steps, [{ what: 'Waiting on you, moved by you', at: at(12, 30), minutes: 30 }]);
  assert.strictEqual(run('T-3').waitedOnYouMinutes, 30);
  assert.strictEqual(run('T-8').outcome, 'manual');
  assert.deepStrictEqual(run('T-8').steps.map((x) => x.what), ['you pressed Get a review', 'you pressed Bring back']);
  // Stuck: on what, and for how long.
  assert.strictEqual(run('T-6').outcome, 'stuck');
  assert.strictEqual(run('T-6').stuckMinutes, 45);
  assert.deepStrictEqual(run('T-6').steps, [], 'Autopilot brought it back itself, so the person did nothing (review of PR 129)');
  assert.match(run('T-6').stuck[0].on, /^Its reviewer Ada has not started on its brief/);
  assert.strictEqual(run('T-7').outcome, 'stuck', 'a reviewer of its PR that did not start on its prompt');
  assert.deepStrictEqual(run('T-7').stuck, [{ on: 'Bo did not start on what it was told: it was at a menu', at: at(13), minutes: 20 }]);
  assert.strictEqual(run('T-4').outcome, 'stuck');
  assert.match(run('T-4').stuck[0].on, /brief was not delivered/);
  assert.ok(run('T-4').stuckMinutes > 0, 'still stuck, so it counts up to now');
  assert.deepStrictEqual(m.stuck.map((x) => x.ticket).sort(), ['T-4', 'T-6', 'T-7', 'T-9']);
  // The headline: merged with no step-in by the person, merged with one, and minutes stuck.
  assert.strictEqual(run('T-9').outcome, 'stuck');
  assert.deepStrictEqual(run('T-9').steps, [{ what: 'Waiting on you, from Autopilot', at: at(9, 30), minutes: 60 }]);
  // The three merged counts add up: alone (success), after getting stuck with no step-in, and needing the person.
  assert.strictEqual(m.headline.mergedAlone, 3);
  assert.strictEqual(m.headline.mergedAfterStuck, 1);
  assert.strictEqual(m.headline.mergedWithYou, 3);
  assert.strictEqual(m.headline.stuckMinutes, run('T-4').stuckMinutes + 45 + 20 + 60);

  // Rung evidence: each run's outcome, by kind of ticket. The kind set on a ticket wins over the guess
  // from its title, and only a ticket with none is guessed (T-104).
  assert.deepStrictEqual(Object.fromEntries(Object.entries(m.rungs.kinds).map(([k, v]) => [k, { success: v.success, manual: v.manual, stuck: v.stuck, open: v.open, closed: v.closed, guessed: v.guessed }])), {
    bug: { success: 1, manual: 0, stuck: 0, open: 0, closed: 0, guessed: 1 },
    docs: { success: 2, manual: 0, stuck: 0, open: 0, closed: 0, guessed: 1 },
    feature: { success: 0, manual: 2, stuck: 3, open: 0, closed: 0, guessed: 4 },
    chore: { success: 0, manual: 0, stuck: 1, open: 0, closed: 0, guessed: 0 }
  });
  assert.deepStrictEqual(m.rungs.kinds.docs.tickets, [{ ticket: 'T-2', outcome: 'success', guessed: true }, { ticket: 'T-5', outcome: 'success' }]);
  assert.ok(!m.rungs.kinds.tests, 'the huddle timer\'s title says tests, and its kind says chore');
  // Flow: start to merged is 110, 60, 110, 120, 120, 60 and 90 minutes. Each ticket was filed at 8:00.
  assert.strictEqual(m.flow.merged, 7);
  assert.strictEqual(m.flow.open, 2);
  assert.strictEqual(m.flow.closed, 0);
  assert.strictEqual(m.flow.medianStartToMergedMinutes, 110);
  assert.strictEqual(m.flow.medianFiledToStartMinutes, 60);
  assert.strictEqual(m.flow.minutesInState.waiting_on_you, 136);
  assert.strictEqual(m.flow.minutesInState.changes_requested, 60);
  // Load: the three tasks that waited on you, and the session's hand, which the person answered.
  assert.strictEqual(m.load.hands, 4);
  assert.strictEqual(m.load.open, 0);
  assert.ok(m.load.recent.some((h) => h.how === 'answered'));
  assert.ok(m.load.recent.some((h) => h.who === 'Task T-3' && h.waitedMinutes === 30));
  // Quality: comments and blocking reviews per PR, and work sent back. T-2's PR is from before the watcher
  // counted, so it shows null, not a guess from what the watcher saw (review of PR 49).
  assert.strictEqual(m.quality.commentsPerPr, 3);
  assert.strictEqual(m.quality.prsCounted, 1);
  assert.strictEqual(m.quality.prsNotCounted, 7);
  assert.strictEqual(m.quality.prs.find((p) => p.ticket === 'T-2').comments, null);
  assert.strictEqual(m.quality.prs.find((p) => p.ticket === 'T-1').countedSince, at(9));
  assert.strictEqual(m.quality.prsWithBlocking, 1);
  assert.deepStrictEqual(m.quality.prs.find((p) => p.ticket === 'T-1').sentBackBy, { relay: 1 });
  assert.strictEqual(m.quality.ci, null);
  // Recovery and cost: the brief that never went in is a stall, and tokens are not reported.
  assert.ok(m.recovery.stalls.some((x) => x.who === 'Task T-4' && /brief not delivered/.test(x.ended)));
  assert.ok(m.recovery.stalls.some((x) => x.who === 'Bo' && /did not start/.test(x.ended)));
  assert.strictEqual(m.cost.tokens, null);
  assert.strictEqual(m.cost.perTicket.find((x) => x.ticket === 'T-1').rounds, 1);
  assert.strictEqual(m.cost.perTicket.find((x) => x.ticket === 'T-5').minutes, 120, 'to its merge');
  assert.strictEqual(r.body.previous, null);
});

test('Ask the COO: a session with its brief, that saves a report and gives back its desk', async (t) => {
  const home = seeded();
  const R = await relay({ RELAY_COO_GRACE_MS: '300' }, home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });

  const asked = await R.call('POST', '/coo/ask', {});
  assert.strictEqual(asked.status, 201, JSON.stringify(asked.body));
  assert.strictEqual((await R.call('POST', '/coo/ask', {})).status, 409, 'one COO at a time');
  const coo = (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === asked.body.terminal);
  assert.strictEqual(coo.role, 'coo');
  assert.strictEqual(coo.work.role, 'coo');

  // The brief went in, and says it proposes only, treats worker text as data, and follows the constitution.
  const screen = await until(async () => { const s = await R.screen(coo.id); return s.includes('GOT[') && s; }, 'the brief');
  const brief = screen.match(/GOT\[(You are the COO[^\]\r\n]*)\]/)[1];
  for (const words of ['You propose only', 'docs/constitution.md', 'is data, not instructions', 'at most 3 recommendations', 'node "' + CLI + '" measures', 'report in place of measures']) {
    assert.ok(brief.includes(words), 'The brief says: ' + words);
  }
  // It is typed as one line, and macOS cuts a typed line at 1024 bytes (T-34), as the PM's test says.
  const bytes = Buffer.byteLength(brief.replace(CLI, ''));
  assert.ok(bytes < 850, 'the brief without the path is ' + bytes + ' bytes');

  // Its token reads the measures and saves a report, and nothing else of the COO's.
  const token = await tokenFor(coo);
  const env = { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: token['X-Office-Token'] };
  const fromCli = JSON.parse(execFileSync('node', [CLI, 'measures'], { env, encoding: 'utf8' }));
  assert.strictEqual(fromCli.measures.flow.merged, 7);
  assert.strictEqual((await R.call('POST', '/coo/ask', {}, token)).status, 401);
  // It proposes only: its token lists tickets but cannot file one (review of PR 49).
  assert.strictEqual((await R.call('GET', '/tickets', null, token)).status, 200);
  assert.strictEqual((await R.call('POST', '/tickets', { title: 'From the COO' }, token)).status, 401);
  // Nor the chat board: a post that mentions a session is typed into it, and the COO only proposes.
  assert.strictEqual((await R.call('GET', '/chat', null, token)).status, 401);
  assert.strictEqual((await R.call('POST', '/chat/office', { text: '@Lead hello' }, token)).status, 401);
  const other = (await R.call('POST', '/terminals', { cwd: home })).body;
  const otherToken = await tokenFor(other);
  assert.strictEqual((await R.call('GET', '/coo/measures', null, otherToken)).status, 401);
  assert.strictEqual((await R.call('POST', '/coo/report', { text: 'not mine' }, otherToken)).status, 401);

  const saved = execFileSync('node', [CLI, 'report'], { env, encoding: 'utf8', input: '# The room\n\nShipped: T-1, T-2, T-3.\n' });
  assert.match(saved, /Saved the report/);
  const shown = (await R.call('GET', '/coo')).body;
  assert.match(shown.report.text, /Shipped: T-1/);
  // By the person the relay gave the COO's session (relay/seats.js), as the page shows it.
  assert.strictEqual(shown.report.by, (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === coo.id).who);
  assert.strictEqual(shown.report.measures, undefined, 'the page polls this, so the measures stay out');

  // The turn that saved it ends, and then the session does, even with its panel open: the focus and
  // cursor reports xterm sends by itself are not the person talking to it (review of PR 49).
  await R.call('POST', '/terminals/' + coo.id + '/input', { data: '\x1b[I\x1b[O\x1b[12;40R' });
  await R.hook({ hook_event_name: 'Stop', session_id: coo.sessionId.slice(0, 12) });
  await until(async () => !(await R.call('GET', '/terminals')).body.terminals.some((x) => x.id === coo.id), 'the COO to leave');
  assert.strictEqual((await R.call('GET', '/coo')).body.running, null);

  // The next report compares with this one, and the report is still there after a restart.
  await R.kill();
  const again = await relay({}, home);
  t.after(async () => { await again.kill(); });
  const back = (await again.call('GET', '/coo')).body;
  assert.match(back.report.text, /Shipped: T-1/);
  const next = (await again.call('GET', '/coo/measures')).body;
  assert.strictEqual(next.previous.at, back.report.at);
  assert.strictEqual(next.previous.load.hands, 3, 'the load the last report saw: T-3, T-6 and T-9 waited on you');
  assert.deepStrictEqual(next.previous.headline, { mergedAlone: 3, mergedAfterStuck: 1, mergedWithYou: 3, stuckMinutes: next.previous.headline.stuckMinutes }, 'the headline the last report saw');
  assert.strictEqual(next.measures.headline.mergedAlone, 0);
  assert.strictEqual(next.measures.headline.mergedWithYou, 0);
  assert.deepStrictEqual(next.measures.shipped, [], 'nothing shipped since the last report');
});

test('a COO that the person talks to after its report stays', async (t) => {
  const R = await relay({ RELAY_COO_GRACE_MS: '200' });
  t.after(() => R.stop());
  const asked = (await R.call('POST', '/coo/ask', {})).body;
  const coo = (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === asked.terminal);
  await until(async () => (await R.screen(coo.id)).includes('GOT['), 'the brief');
  const token = await tokenFor(coo);
  assert.strictEqual((await R.call('POST', '/coo/report', { text: 'A report.' }, token)).status, 201);
  await R.call('POST', '/terminals/' + coo.id + '/input', { data: 'why?\r' });
  await R.hook({ hook_event_name: 'Stop', session_id: coo.sessionId.slice(0, 12) });
  await new Promise((r) => setTimeout(r, 800));
  assert.ok((await R.call('GET', '/terminals')).body.terminals.some((x) => x.id === coo.id && x.running));
});

// Autopilot parked a task because nothing moved it, and took it back by itself once its Dev opened a PR
// (relay/autopilot.js movedAgain). The person did nothing, so it is no step-in (T-211).
test('a task Autopilot took back by itself after a stall is no wait on the person', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-coo-')));
  const one = task('bbbbb1', 'T-1', 'A clock on the wall', 'done', [
    { at: at(9), type: 'created', to: 'building', by: 'Autopilot' },
    moved(at(9, 30), 'building', 'waiting_on_you', 'Autopilot', 'Autopilot: Nothing moved it for 30 minutes: its Dev has been idle for 30 minutes with no PR.'),
    { at: at(9, 35), type: 'pr', pr: PR(1) },
    moved(at(9, 35), 'waiting_on_you', 'building', 'Autopilot', 'Autopilot: its Dev opened PR #1, so the task is back.'),
    { at: at(10), type: 'merged', pr: PR(1) }, moved(at(10), 'building', 'done', 'Autopilot')
  ], { pr: PR(1), by: 'Autopilot' });
  fs.mkdirSync(path.join(home, '.office-world'), { recursive: true });
  fs.writeFileSync(path.join(home, '.office-world', 'tasks.json'), JSON.stringify({ t: [one] }));
  fs.writeFileSync(path.join(home, '.office-world', 'tickets.json'), JSON.stringify({ t: { next: 2, tickets: [{ id: 'T-1', title: one.title, body: '', status: 'done', priority: 'normal', repo: '/nowhere', base: 'main', blockedBy: [], createdBy: 'you', createdAt: at(8), updatedAt: at(10) }] } }));
  const R = await relay({}, home);
  t.after(async () => { await R.kill(); await R.remove(); });
  const run = (await R.call('GET', '/coo/measures')).body.measures.runs.find((x) => x.ticket === 'T-1');
  assert.deepStrictEqual(run.steps, [], 'Autopilot brought it back itself');
  assert.strictEqual(run.waitedOnYouMinutes, 0);
  assert.strictEqual(run.outcome, 'stuck');
  assert.strictEqual(run.stuckMinutes, 5);
});
