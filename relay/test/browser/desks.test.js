// Each desk on the workers row in a browser (relay/test/browser/page.js), with WebGL off: a task's Dev shows
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
  const row = (title) => p.page.locator('#cards .pair', { hasText: title });
  await row('Finished work').locator('.next', { hasText: 'Next: Done, safe to stop' }).waitFor();
  assert.match(await row('Finished work').locator('.state').innerText(), /^idle \d+ min · Done$/);
  assert.match(await row('Finished work').locator('.desk-stop').innerText(), /^Safe to stop: its task is Done, idle \d+ min/);
  await row('Work in review').locator('.state', { hasText: 'In review' }).waitFor();
  assert.strictEqual(await row('Work in review').locator('.desk-stop').count(), 0, 'a Dev in review is not safe to stop');
  const all = p.page.locator('#stop-safe');
  assert.strictEqual(await all.innerText(), 'Stop all safe · 1');
  await all.click();
  await p.page.locator('#stop-note', { hasText: /^Stopped / }).waitFor();
  await until(async () => !(await running(done.id)), 'the Done Dev to stop');
  assert.ok(await running(review.id), 'the Dev in review keeps running');
  await all.waitFor({ state: 'hidden' });
  assert.deepStrictEqual(p.errors, []);
});

// T-126: who reviews whom, at a glance. A reviewer sits in the card of the Dev whose PR it reviews, and
// the card names that PR. A reviewer whose PR has no Dev on the Floor stays a card of its own.
pageTest('a reviewer sits in the card of the Dev whose PR it reviews, and the card names the PR', get, async (p) => {
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
  const named = (name) => p.page.locator('.desk', { has: p.page.locator('b', { hasText: new RegExp('^' + name + '$') }) });
  const card = p.page.locator('#cards .pair:not(.single)', { has: named(devName) });
  await card.locator('b', { hasText: new RegExp('^' + reviewerName + '$') }).waitFor();
  assert.strictEqual(await card.locator('.pair-cap a', { hasText: '#31' }).getAttribute('href'), PR, 'the card names the PR, linked');
  const lonely = p.page.locator('#cards .pair.single', { has: named(loneName) });
  await lonely.waitFor();
  assert.match(await lonely.locator('.pair-cap').innerText(), /Reviewer/);
  assert.match(await lonely.innerText(), /PR #77/);
  assert.strictEqual(await p.page.locator('#cards .pair:not(.single) .desk').count(), 2, 'one card holds the Dev and its reviewer');
  assert.deepStrictEqual(p.errors, []);
});
