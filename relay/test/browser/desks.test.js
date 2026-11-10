// Each desk on the Floor in a browser (relay/test/browser/page.js), with WebGL off: a task's Dev shows
// its column, the next step and Safe to stop with a Stop button, and Stop all safe stops only the
// desks that are safe.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeRepo, until, sleep } = require('../helpers.js');
const { office, pageTest } = require('./page.js');

let o;
test.before(async () => { o = await office({ env: { RELAY_WIP_LIMIT: '5' } }); });
test.after(() => o && o.stop());
const get = () => o;

// A task's Dev, briefed and idle after one turn, with its task moved to state.
async function dev(repo, title, state) {
  const { R } = o;
  const task = (await R.call('POST', '/tasks', { title, repo })).body.task;
  const id = task.owner.terminal, sid = task.owner.sessionId.slice(0, 12);
  await until(async () => (await R.screen(id)).includes('GOT['), 'the task brief');
  for (const ev of ['UserPromptSubmit', 'Stop']) { await R.hook({ session_id: sid, hook_event_name: ev, title: '' }); await sleep(150); }
  if (state) assert.strictEqual((await R.call('POST', '/tasks/' + task.id + '/move', { to: state })).status, 200);
  return { id, task };
}
const running = async (id) => (await o.R.call('GET', '/terminals')).body.terminals.some((x) => x.id === id && x.running);

pageTest('each desk says its column and next step, and Stop all safe stops only the safe ones', get, async (p) => {
  // A remote that main is pushed to, so a Done Dev has nothing that is not pushed.
  const repo = makeRepo(o.R.home, 'desk-repo'), origin = path.join(o.R.home, 'desk-origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: repo });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: repo });
  const done = await dev(repo, 'Finished work', 'done'), review = await dev(repo, 'Work in review', 'in_review');
  await p.open();
  const row = (title) => p.page.locator('#people li', { hasText: title });
  await row('Finished work').locator('.desk-next', { hasText: 'Next: Done, safe to stop' }).waitFor();
  assert.match(await row('Finished work').locator('.desk-now').innerText(), /^idle \d+ min · Done$/);
  assert.match(await row('Finished work').locator('.desk-stop').innerText(), /^Safe to stop: its task is Done, idle \d+ min/);
  await row('Work in review').locator('.desk-now', { hasText: 'In review' }).waitFor();
  assert.ok(await row('Work in review').locator('.desk-stop').isHidden(), 'a Dev in review is not safe to stop');
  const all = p.page.locator('#stop-safe');
  assert.strictEqual(await all.innerText(), 'Stop all safe · 1');
  await all.click();
  await p.page.locator('#stop-note', { hasText: /^Stopped / }).waitFor();
  await until(async () => !(await running(done.id)), 'the Done Dev to stop');
  assert.ok(await running(review.id), 'the Dev in review keeps running');
  await all.waitFor({ state: 'hidden' });
  assert.deepStrictEqual(p.errors, []);
});

// T-126: who reviews whom, at a glance. A reviewer's row sits right under the Dev whose PR it reviews,
// indented, and both name the same PR. A reviewer whose PR has no Dev on the Floor stays a row of its own.
pageTest('a reviewer sits under the Dev whose PR it reviews, and both name the PR', get, async (p) => {
  const { R } = o;
  const repo = makeRepo(R.home, 'pair-repo'), PR = 'https://github.com/o/r/pull/31', LONE = 'https://github.com/o/r/pull/77';
  const built = await dev(repo, 'Work with a PR');
  const wt = (await R.call('GET', '/tasks')).body.tasks.find((x) => x.id === built.task.id).worktree;
  await R.hook({ session_id: built.task.owner.sessionId.slice(0, 12), hook_event_name: 'PostToolUse', pr_url: PR, cwd: wt });
  const reviewer = (await R.call('POST', '/terminals', { cwd: repo, role: 'reviewer', pr: PR, title: 'Review' })).body;
  const lone = (await R.call('POST', '/terminals', { cwd: repo, role: 'reviewer', pr: LONE, title: 'Review' })).body;
  const who = async (id) => (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === id).who;
  const [devName, reviewerName, loneName] = [await who(built.id), await who(reviewer.id), await who(lone.id)];
  await p.open();
  const pair = (name) => p.page.locator('#people li', { has: p.page.locator('b', { hasText: new RegExp('^' + name + '$') }) }).locator('.desk-pair');
  await pair(devName).filter({ hasText: 'reviewed by ' + reviewerName }).waitFor();
  await pair(reviewerName).filter({ hasText: 'reviewing PR #31 for ' + devName }).waitFor();
  await pair(loneName).filter({ hasText: 'reviewing PR #77' }).waitFor();
  const rows = await p.page.$$eval('#people li', (lis) => lis.map((li) => ({ name: li.querySelector('b').textContent, under: li.dataset.under || '', pair: li.querySelector('.desk-pair').textContent })));
  const at = rows.findIndex((r) => r.name === devName);
  assert.deepStrictEqual(rows[at + 1], { name: reviewerName, under: '1', pair: 'reviewing PR #31 for ' + devName }, JSON.stringify(rows));
  assert.deepStrictEqual(rows.find((r) => r.name === loneName), { name: loneName, under: '', pair: 'reviewing PR #77' });
  const indent = (name) => p.page.locator('#people li', { has: p.page.locator('b', { hasText: new RegExp('^' + name + '$') }) }).evaluate((li) => li.getBoundingClientRect().left);
  assert.ok(await indent(reviewerName) > await indent(devName), 'the reviewer\'s row is indented');
  assert.deepStrictEqual(p.errors, []);
});
