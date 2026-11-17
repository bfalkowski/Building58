'use strict';
// A PR of another project gets no automatic review (T-192). The person's global hooks send every
// session's events to the relay, so a session outside the room that opens a PR in another repo reaches
// it too. That PR is ignored quietly. A review the checkout refuses as unrelated is dropped, not tried
// again and not handed to the person.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep } = require('./helpers.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const QUIET = 2500;

test('a PR of another project gets no automatic review and tells nobody', async (t) => {
  const R = await relay({ RELAY_REVIEW_RETRY_MS: '300' }, null, { autoReview: true }), repo = makeRepo(R.home);
  t.after(R.stop);
  const widgets = path.join(R.home, 'widgets.git'), elsewhereGit = path.join(R.home, 'elsewhere.git');
  for (const bare of [widgets, elsewhereGit]) sh(R.home, 'init', '-q', '--bare', bare);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + widgets + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n' +
    '[url "' + elsewhereGit + '"]\n\tinsteadOf = https://github.com/acme/elsewhere.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-q', widgets, 'HEAD:refs/pull/1/head');
  const elsewhere = path.join(R.home, 'elsewhere');  // no history in common with repo
  sh(R.home, 'init', '-q', '-b', 'main', elsewhere);
  sh(elsewhere, 'remote', 'add', 'origin', 'https://github.com/acme/elsewhere.git');
  fs.writeFileSync(path.join(elsewhere, 'b.txt'), 'another project\n');
  sh(elsewhere, 'add', 'b.txt');
  sh(elsewhere, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'another project');
  for (const n of [1, 2]) sh(elsewhere, 'push', '-q', elsewhereGit, 'HEAD:refs/pull/' + n + '/head');
  assert.strictEqual((await R.call('POST', '/tickets', { title: 'Work in widgets', repo })).status, 201);

  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  const reviewersOf = async (pr) => (await terminals()).filter((x) => x.role === 'reviewer' && x.pr === pr);
  const reviews = async () => (await R.call('GET', '/reviews')).body;
  const saved = () => { try { return JSON.parse(fs.readFileSync(path.join(R.home, '.office-world', 'deliveries.json'), 'utf8')).t || []; } catch (e) { return []; } };
  const stop = async (id) => { await R.call('POST', '/terminals/' + id + '/stop', {}); await until(async () => !(await terminals()).some((x) => x.id === id), 'it to stop'); };
  const outside = (pr, cwd) => R.hook({ hook_event_name: 'PostToolUse', session_id: 'outside-' + pr.split('/').pop(), pr_url: pr, cwd });
  const nobodyTold = async (pr) => {
    const number = '#' + pr.split('/').pop();
    assert.deepStrictEqual(await reviewersOf(pr), [], 'no reviewer');
    const r = await reviews();
    assert.strictEqual(r.prs.find((x) => x.pr === pr), undefined, 'no review is queued or kept');
    assert.deepStrictEqual(r.news.filter((x) => JSON.stringify(x).includes('PR ' + number)), [], 'no line on the panel or the Floor');
    assert.deepStrictEqual(saved().filter((x) => (x.text || '').includes(pr) || (x.key || '').includes(pr)), [], 'no message for the Lead or anyone');
  };

  await t.test('a session outside the room in the room\'s repo opens a PR of another repo: ignored', async () => {
    const pr = 'https://github.com/acme/elsewhere/pull/1';
    await outside(pr, repo);
    await until(() => R.output().includes(pr), 'the relay to log it', 300);
    await sleep(QUIET);
    await nobodyTold(pr);
    assert.match(R.output(), /is not of a repo the room works in/);
  });

  await t.test('a session outside the room in another repo\'s folder opens its PR: ignored', async () => {
    const pr = 'https://github.com/acme/elsewhere/pull/2';
    await outside(pr, elsewhere);
    await until(() => R.output().includes(pr), 'the relay to log it', 300);
    await sleep(QUIET);
    await nobodyTold(pr);
  });

  await t.test('a session outside the room opens a PR of the room\'s repo: it gets its review', async () => {
    const pr = 'https://github.com/acme/widgets/pull/1';
    await outside(pr, repo);
    const r = await until(async () => (await reviewersOf(pr))[0], 'a review of ' + pr);
    await stop(r.id);
  });

  await t.test('a review refused as unrelated is tried once and dropped, not handed to the person', async () => {
    const d = (await R.call('POST', '/terminals', { cwd: repo })).body;
    const pr = 'https://github.com/acme/elsewhere/pull/2';
    await R.hook({ hook_event_name: 'PostToolUse', session_id: d.sessionId.slice(0, 12), pr_url: pr, cwd: repo });
    await until(() => /shares no history/.test(R.output()), 'the checkout to refuse it', 300);
    await sleep(QUIET);
    assert.strictEqual(R.output().match(/shares no history/g).length, 1, 'one try, no retry');
    await nobodyTold(pr);
    const row = (await R.call('GET', '/floor')).body.sessions.find((x) => x.terminal === d.id);
    assert.strictEqual(row.reviewWaits, false, 'the Floor does not say it waits on the person');
    await stop(d.id);
  });
});
