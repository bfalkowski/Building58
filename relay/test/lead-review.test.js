// T-98: the Lead asks the relay for a review of a task's PR, with ticket.js review, while the person's
// switch Let the Lead start reviews is on. The relay starts the reviewer Get a review starts, in its own
// checkout. It refuses a PR that is no task's, a PR a reviewer is on, an ask with no desk free, and a PR
// past the per-PR limit the automatic reviews have. While Autopilot is on, the switch is not needed (T-333).
// Through a real relay with a fake `claude`.
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const PR = 'https://github.com/acme/widgets/pull/42';
const OTHER = 'https://github.com/acme/widgets/pull/43';
const CLI = path.join(H.ROOT, 'relay', 'ticket.js');

async function office(R) {
  const repo = H.makeRepo(R.home);
  // The PR's head is on a bare origin, as GitHub keeps refs/pull/N/head, so the reviewer's checkout is real.
  const origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', origin, 'HEAD:refs/pull/42/head', 'HEAD:refs/pull/43/head');
  const head = sh(repo, 'rev-parse', 'HEAD');

  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const reviewersOf = async (pr) => (await terminals()).filter((x) => x.role === 'reviewer' && x.pr === pr);
  const stop = async (id) => { await R.call('POST', '/terminals/' + id + '/stop', {}); await H.until(async () => !(await terminals()).some((x) => x.id === id), 'it to stop'); };
  const tokenOf = (s) => H.until(() => { try { return { 'X-Office-Token': H.sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'the token');
  const count = async (pr) => { const p = (await R.call('GET', '/reviews')).body.prs.find((x) => x.pr === pr); return p ? p.count : 0; };
  const ask = (pr, who) => R.call('POST', '/reviews/lead', { pr }, who);
  const lights = (on) => R.call('POST', '/settings', { values: { leadReviews: on } });
  const cli = (token, ...args) => spawnSync('node', [CLI, ...args], { env: { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: token }, encoding: 'utf8' });

  // A ticket started into a task whose Dev opened PR 42.
  const ticket = (await R.call('POST', '/tickets', { title: 'Has a PR', repo })).body.ticket;
  assert.strictEqual((await R.call('POST', '/tickets/' + ticket.id + '/start', {})).status, 200);
  const task = await H.until(async () => (await R.call('GET', '/tasks')).body.tasks.find((x) => x.ticket === ticket.id && x.worker), 'the task');
  const dev = (await terminals()).find((x) => x.id === task.worker.terminal);
  await R.hook({ hook_event_name: 'PostToolUse', session_id: dev.sessionId.slice(0, 12), pr_url: PR, cwd: task.worktree });
  await H.until(async () => (await R.call('GET', '/tasks')).body.tasks.find((x) => x.id === task.id).pr === PR, 'the task\'s PR');

  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: lead.sessionId.slice(0, 12), title: '' });
  await H.sleep(200);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id })).status, 200);
  const leadT = await tokenOf(lead), devT = await tokenOf(dev);

  return { repo, head, task, dev, lead, leadT, devT, terminals, reviewersOf, stop, tokenOf, count, ask, lights, cli };
}

test('the Lead starts a review through the relay, within its switch and the limits', async (t) => {
  const R = await H.relay({ RELAY_WIP_LIMIT: '5' });
  t.after(R.stop);
  const { repo, head, task, leadT, devT, terminals, reviewersOf, stop, tokenOf, count, ask, lights, cli } = await office(R);

  await t.test('off by default: the Lead gets 403 and no reviewer starts', async () => {
    const s = (await R.call('GET', '/settings')).body.settings.find((x) => x.name === 'leadReviews');
    assert.deepStrictEqual([s.value, s.group, s.label], [false, 'The Lead', 'Let the Lead start reviews']);
    const r = await ask(PR, leadT);
    assert.strictEqual(r.status, 403);
    assert.match(r.body.message, /Let the Lead start reviews/);
    assert.match(r.body.message, /Never review it in your own session/);
    const out = cli(leadT['X-Office-Token'], 'review', PR);
    assert.strictEqual(out.status, 1);
    assert.match(out.stderr, /Let the Lead start reviews/);
    assert.deepStrictEqual(await reviewersOf(PR), []);
    assert.strictEqual(await count(PR), 0);
  });

  await t.test('on: only the Lead\'s token asks; a Dev\'s gets 401 and the person\'s key 403', async () => {
    assert.strictEqual((await lights(true)).status, 200);
    assert.strictEqual((await ask(PR, devT)).status, 401);
    const r = await ask(PR);
    assert.strictEqual(r.status, 403);
    assert.match(r.body.message, /Get a review/);
    assert.deepStrictEqual(await reviewersOf(PR), []);
  });

  await t.test('a PR that is no task\'s, or not a PR link, is refused', async () => {
    let r = await ask(OTHER, leadT);
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.error, 'not_a_task');
    r = await ask('https://example.com/pull/1', leadT);
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(await reviewersOf(OTHER), []);
    assert.strictEqual(await count(OTHER), 0);
  });

  let first;
  await t.test('ticket.js review starts the Get a review reviewer, in its own checkout of the PR head, which posts', async () => {
    const out = cli(leadT['X-Office-Token'], 'review', PR);
    assert.strictEqual(out.status, 0, out.stderr);
    assert.match(out.stdout, /^Review started: https:\/\/github\.com\/acme\/widgets\/pull\/42 .*\(1 of 3 for this PR\)/);
    [first] = await reviewersOf(PR);
    assert.ok(first, 'a reviewer is on the Floor');
    assert.strictEqual(first.title, 'Review PR #42');
    const checkout = (await R.call('GET', '/checkouts')).body.checkouts.find((c) => c.path === first.cwd);
    assert.ok(checkout && checkout.kind === 'reviewer', 'its own checkout');
    assert.strictEqual(checkout.commit, head, 'of the PR\'s head');
    assert.notStrictEqual(first.cwd, task.worktree);
    const { prBrief } = require('../../office/reviews.js');
    await H.until(async () => (await R.screen(first.id)).includes('Post your findings as a PR comment.'), 'the brief');
    assert.ok((await R.screen(first.id)).includes(prBrief(PR).slice(0, 60)), 'the Get a review brief for a session with a PR');
    assert.strictEqual(await count(PR), 1);
    const steps = (await R.call('GET', '/tasks')).body.tasks.find((x) => x.id === task.id).history;
    assert.ok(steps.some((h) => h.type === 'review_asked' && h.by === 'Lead'), 'the task says the Lead asked');
  });

  await t.test('a PR that a reviewer is on is refused, and is not counted', async () => {
    const r = await ask(PR, leadT);
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, 'reviewing');
    assert.strictEqual((await reviewersOf(PR)).length, 1);
    assert.strictEqual(await count(PR), 1);
    await stop(first.id);
  });

  await t.test('an ask with no desk free is refused, and is not counted', async () => {
    const others = [];
    while ((await terminals()).length < 9) others.push((await R.call('POST', '/terminals', { cwd: repo })).body);
    const r = await ask(PR, leadT);
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, 'full');
    assert.deepStrictEqual(await reviewersOf(PR), []);
    assert.strictEqual(await count(PR), 1);
    for (const o of others) await stop(o.id);
  });

  await t.test('the relay counts each review in the per-PR count the automatic ones use, and stops at 3', async () => {
    for (const n of [2, 3]) {
      const r = await ask(PR, leadT);
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      assert.deepStrictEqual([r.body.count, r.body.max], [n, 3]);
      const [rv] = await reviewersOf(PR);
      await stop(rv.id);
    }
    const r = await ask(PR, leadT);
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, 'limit');
    assert.match(r.body.message, /the person/);
    assert.deepStrictEqual(await reviewersOf(PR), []);
    assert.strictEqual(await count(PR), 3);
  });

  await t.test('a session that is no longer the Lead gets 401, and off again refuses the new Lead', async () => {
    const next = (await R.call('POST', '/terminals', { cwd: repo })).body;
    await R.hook({ hook_event_name: 'UserPromptSubmit', session_id: next.sessionId.slice(0, 12), title: '' });
    await H.sleep(200);
    assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: next.id })).status, 200);
    assert.strictEqual((await ask(PR, leadT)).status, 401, 'the old Lead');
    assert.strictEqual((await lights(false)).status, 200);
    const r = await ask(PR, await tokenOf(next));
    assert.strictEqual(r.status, 403, 'the new Lead, with the switch off');
    assert.match(r.body.message, /Let the Lead start reviews/);
  });
});

test('an automatic review and the Lead\'s count toward the same per-PR limit', async (t) => {
  const R = await H.relay({ RELAY_WIP_LIMIT: '5' }, null, { autoReview: true });
  t.after(R.stop);
  assert.strictEqual((await R.call('POST', '/settings', { values: { maxAutoReviews: 2, leadReviews: true } })).status, 200);
  const { leadT, reviewersOf, stop, count, ask } = await office(R);
  const auto = await H.until(async () => (await reviewersOf(PR))[0], 'the automatic first review');
  assert.strictEqual(await count(PR), 1);
  await stop(auto.id);
  const r = await ask(PR, leadT);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.count, r.body.max], [2, 2]);
  const [rv] = await reviewersOf(PR);
  await stop(rv.id);
  const past = await ask(PR, leadT);
  assert.strictEqual(past.status, 409);
  assert.strictEqual(past.body.error, 'limit');
  assert.deepStrictEqual(await reviewersOf(PR), []);
});

test('while Autopilot is on the Lead starts a review with Let the Lead start reviews off (T-333)', async (t) => {
  const R = await H.relay({ RELAY_WIP_LIMIT: '5' });
  t.after(R.stop);
  const { leadT, reviewersOf, stop, count, ask } = await office(R);
  const switchOn = async () => (await R.call('GET', '/settings')).body.settings.find((x) => x.name === 'leadReviews').value;
  const autopilot = async (on) => (await R.call('POST', '/autopilot', on ? { on: true, only: 'T-999999' } : { on: false })).body.on;

  let r = await ask(PR, leadT);
  assert.strictEqual(r.status, 403, 'Autopilot off and the switch off');
  assert.deepStrictEqual(await reviewersOf(PR), []);

  assert.strictEqual(await autopilot(true), true);
  r = await ask(PR, leadT);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(await switchOn(), false, 'the switch itself stays off');
  const [rv] = await reviewersOf(PR);
  assert.ok(rv, 'a reviewer is on the Floor');
  assert.strictEqual(await count(PR), 1);
  await stop(rv.id);

  assert.strictEqual(await autopilot(false), false);
  r = await ask(PR, leadT);
  assert.strictEqual(r.status, 403, 'Autopilot off again, so the switch decides');
  assert.match(r.body.message, /or turn on Autopilot/);
  assert.deepStrictEqual(await reviewersOf(PR), []);
  assert.strictEqual(await count(PR), 1);
});
