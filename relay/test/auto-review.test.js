'use strict';
// The relay starts the automatic reviews itself (T-54): the first review of a new PR, and a follow-up
// review after a push to a reviewed PR. No room page is connected in any of these tests, so the
// relay alone has to do it.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep } = require('./helpers.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const PR = (n) => 'https://github.com/acme/widgets/pull/' + n;
const QUIET = 2500;  // long enough for the relay's one-second check to have run twice

test('the relay starts the first review and the follow-ups, with no page open', async (t) => {
  const R = await relay({ RELAY_REVIEW_RETRY_MS: '500' }, null, { autoReview: true }), repo = makeRepo(R.home);
  t.after(R.stop);
  const origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  // acme/other has no remote in the folder, so its PR is fetched from its own repo (T-8). That leads
  // nowhere, so the fetch fails here and not on the network.
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n' +
    '[url "' + path.join(R.home, 'nowhere.git') + '"]\n\tinsteadOf = https://github.com/acme/other.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  let n = 0;
  // A new commit on the PR's head, as a Dev's git push leaves it on GitHub.
  const commit = (pr) => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'change ' + (++n) + '\n');
    sh(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'change ' + n);
    sh(repo, 'push', '-qf', origin, 'HEAD:refs/pull/' + pr.split('/').pop() + '/head');
    return sh(repo, 'rev-parse', 'HEAD');
  };
  const say = (s, event, extra) => R.hook(Object.assign({ hook_event_name: event, session_id: s.sessionId.slice(0, 12) }, extra));
  const opens = (s, pr) => say(s, 'PostToolUse', { pr_url: pr, cwd: repo });
  const pushes = (s) => say(s, 'PostToolUse', { pushed: true });
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const reviewersOf = async (pr) => (await terminals()).filter((x) => x.role === 'reviewer' && x.pr === pr);
  const seen = new Set();
  const newReviewer = (pr) => until(async () => (await reviewersOf(pr)).find((x) => !seen.has(x.id) && seen.add(x.id)), 'a review of ' + pr);
  const noNewReviewer = async (pr, why) => { await sleep(QUIET); assert.deepStrictEqual((await reviewersOf(pr)).filter((x) => !seen.has(x.id)), [], why); };
  const stop = async (s) => { await R.call('POST', '/terminals/' + s.id + '/stop', {}); await until(async () => !(await terminals()).some((x) => x.id === s.id), 'it to stop'); };
  const commitOf = async (s) => (await R.call('GET', '/checkouts')).body.checkouts.find((c) => c.path === s.cwd).commit;
  const dev = async () => { const r = await R.call('POST', '/terminals', { cwd: repo }); assert.strictEqual(r.status, 201, JSON.stringify(r.body)); return r.body; };
  const reviews = async () => (await R.call('GET', '/reviews')).body;

  await t.test('the first review starts from the relay, and a follow-up stays off until the person turns it on', async () => {
    const r = await reviews();
    assert.deepStrictEqual([r.auto, r.again, r.max], [true, false, 3], 'the first review starts on, as on the page before; the follow-up starts off');
    const d = await dev(), pr = PR(7);
    commit(pr);
    await opens(d, pr);
    const first = await newReviewer(pr);
    assert.strictEqual(first.title, 'Review PR #7');
    await stop(first);
    commit(pr);
    await pushes(d); await say(d, 'Stop');
    await noNewReviewer(pr, 'Review again after each push is off');
    await stop(d);
  });

  await t.test('a push to a reviewed PR starts one follow-up of the latest head, once its review and the Dev\'s turn are done', async () => {
    assert.strictEqual((await R.call('POST', '/reviews', { again: true })).body.again, true);
    const d = await dev(), pr = PR(8);
    const h1 = commit(pr);
    await opens(d, pr);
    const first = await newReviewer(pr);
    assert.strictEqual(await commitOf(first), h1);
    await say(d, 'UserPromptSubmit');
    commit(pr); await pushes(d);
    const h3 = commit(pr); await pushes(d);
    await say(d, 'Stop');
    await noNewReviewer(pr, 'the first review is still running, and it read an older commit');
    await stop(first);
    const second = await newReviewer(pr);
    assert.strictEqual(await commitOf(second), h3, 'only the latest head is reviewed');
    await until(async () => (await R.screen(second.id)).includes('New commits were pushed'), 'the follow-up brief');
    assert.match(await R.screen(second.id), /earlier review comment/);
    await noNewReviewer(pr, 'two pushes bring one follow-up');
    await stop(second);

    await say(d, 'UserPromptSubmit');
    const h4 = commit(pr); await pushes(d);
    await noNewReviewer(pr, 'the Dev is still in its turn and may push again');
    await say(d, 'Stop');
    const third = await newReviewer(pr);
    assert.strictEqual(await commitOf(third), h4);
    await stop(third);
    assert.strictEqual((await reviews()).prs.find((p) => p.pr === pr).count, 3);

    // The fourth would pass the limit: the PR waits on the person, and the Floor and the Lead say so.
    commit(pr); await pushes(d); await say(d, 'Stop');
    await noNewReviewer(pr, 'at most 3 automatic reviews for each PR');
    const p = (await reviews()).prs.find((x) => x.pr === pr);
    assert.deepStrictEqual([p.count, p.waits], [3, true]);
    const row = (await R.call('GET', '/floor')).body.sessions.find((x) => x.terminal === d.id);
    assert.strictEqual(row.reviewWaits, true, JSON.stringify(row));
    assert.strictEqual(row.pr, pr);
    const saved = JSON.parse(fs.readFileSync(path.join(R.home, '.office-world', 'deliveries.json'), 'utf8')).t;
    const forLead = saved.find((x) => x.to === 'lead' && x.text.includes(pr));
    assert.ok(forLead, 'a message waits for the Lead');
    assert.match(forLead.text, /waits on the person/);

    // Get a review by the person reviews it, and the Floor stops saying it waits.
    const r = await R.call('POST', '/checkouts', { from: repo, pr });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    seen.add(r.body.id);
    assert.strictEqual((await R.call('GET', '/floor')).body.sessions.find((x) => x.terminal === d.id).reviewWaits, false);
    await stop(r.body);
    await stop(d);
  });

  await t.test('a push that moved nothing starts no review and uses none of the 3', async () => {
    const d = await dev(), pr = PR(9);
    commit(pr);
    await opens(d, pr);
    await stop(await newReviewer(pr));
    await pushes(d); await say(d, 'Stop');
    await noNewReviewer(pr, 'the PR is still at the commit its review read');
    assert.strictEqual((await reviews()).prs.find((x) => x.pr === pr).count, 1);
    assert.match(R.output(), /PR #9 has no new commits since its last review/);
    await stop(d);
  });

  await t.test('a first review with no desk free starts once a desk is free', async () => {
    const d = await dev(), pr = PR(10), others = [];
    while ((await terminals()).length < 9) others.push(await dev());
    commit(pr);
    await opens(d, pr);
    await noNewReviewer(pr, 'all 9 desks are taken');
    assert.match(R.output(), /No desk is free for the review of PR #10/);
    const p = (await reviews()).prs.find((x) => x.pr === pr);
    assert.deepStrictEqual([p.count, p.desk], [0, true], 'it waits for a desk, and is not counted yet');
    await stop(others.pop());
    await stop(await newReviewer(pr));
    assert.strictEqual((await reviews()).prs.find((x) => x.pr === pr).count, 1);
    for (const o of others) await stop(o);
    await stop(d);
  });

  await t.test('a first review that keeps failing for another reason waits on the person', async () => {
    const d = await dev(), pr = 'https://github.com/acme/other/pull/3';  // the folder has no remote for acme/other, and its own repo cannot be reached
    await opens(d, pr);
    await until(async () => { const p = (await reviews()).prs.find((x) => x.pr === pr); return p && p.failed; }, 'it to give up after 3 tries');
    const p = (await reviews()).prs.find((x) => x.pr === pr);
    assert.deepStrictEqual([p.count, p.held], [0, false]);
    assert.match(p.failed, /fetching https:\/\/github\.com\/acme\/other\/pull\/3 from its own repo failed/);
    assert.match(R.output(), /The first review of PR #3 could not start 3 times/);
    const row = (await R.call('GET', '/floor')).body.sessions.find((x) => x.terminal === d.id);
    assert.strictEqual(row.reviewWaits, true, 'the Floor keeps showing it until someone acts');
    await stop(d);
  });

  await t.test('only the room page sets the switches', async () => {
    const r = await R.call('POST', '/reviews', { again: false }, { 'X-Office-Token': 'nope' });
    assert.strictEqual(r.status, 401);
    assert.strictEqual((await reviews()).again, true);
  });
});

test('the switches are the relay\'s, so a restart keeps them', async (t) => {
  const R = await relay({}, null, { autoReview: true });
  t.after(R.remove);
  assert.strictEqual((await R.call('POST', '/reviews', { auto: false, again: true })).status, 200);
  assert.strictEqual((await R.call('POST', '/reviews', { again: 'yes' })).status, 400);
  await R.kill();
  const again = await relay({}, R.home, { autoReview: true });
  t.after(again.kill);
  const r = (await again.call('GET', '/reviews')).body;
  assert.deepStrictEqual([r.auto, r.again], [false, true]);
});
