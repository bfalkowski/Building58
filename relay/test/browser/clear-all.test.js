// One button per pile of overnight rows (T-420), in a browser (relay/test/browser/page.js), with WebGL off:
// OK all marks every finished reviewer row as seen, and Clean up all cleans every leftover checkout and
// every done task with the call each row's own button uses. A checkout that holds files git ignores is
// not deleted: it stays and asks, and the one line says so.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeRepo, until } = require('../helpers.js');
const { office, pageTest, errorsBut } = require('./page.js');

let o;
test.before(async () => { o = await office({ env: { RELAY_WIP_LIMIT: '5' } }); });
test.after(() => o && o.stop());
const get = () => o;

const commit = (cwd, file) => {
  fs.writeFileSync(path.join(cwd, file), 'x\n');
  execFileSync('git', ['add', file], { cwd });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', file], { cwd });
};
const running = async (id) => (await o.R.call('GET', '/terminals')).body.terminals.some((x) => x.id === id && x.running);
async function stopped(id) {
  await o.R.call('POST', '/terminals/' + id + '/stop', {});
  await until(async () => !(await running(id)), 'the session to stop');
}
// A checkout of repo with a commit in it and nobody in it, so it stays as a row.
async function leftover(repo, ignored) {
  const r = await o.R.call('POST', '/checkouts', { from: repo });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  commit(r.body.cwd, 'work.txt');
  if (ignored) fs.writeFileSync(path.join(r.body.cwd, 'secret.env'), 'A=1\n');
  await stopped(r.body.id);
  return { cwd: r.body.cwd, id: r.body.checkout.id };
}
async function doneTask(repo, title) {
  const task = (await o.R.call('POST', '/tasks', { title, repo })).body.task;
  assert.ok(task, 'the task started');
  assert.strictEqual((await o.R.call('POST', '/tasks/' + task.id + '/move', { to: 'done' })).status, 200);
  await stopped(task.owner.terminal);
  return task;
}

pageTest('one click clears each pile, and a checkout with ignored files still asks', get, async (p) => {
  const repo = makeRepo(o.R.home, 'pile-repo');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'secret.env\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'ignore'], { cwd: repo });
  const plain = [await leftover(repo), await leftover(repo)], kept = await leftover(repo, true);
  const tasks = [await doneTask(repo, 'Night task one'), await doneTask(repo, 'Night task two'), await doneTask(repo, 'Night task three')];

  // Three reviews that finished in the night. Only a reviewer's real end makes one, so the page reads them
  // from the relay's answer with these added.
  const finished = [1, 2, 3].map((n) => ({ id: 'rev' + n, title: 'Review PR #' + n, pr: 'https://github.com/o/r/pull/' + n, kind: 'comment', url: 'https://github.com/o/r/pull/' + n, at: '2026-11-22T0' + n + ':00:00.000Z' }));
  await p.page.route((u) => u.pathname === '/channels/t/terminals', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch(), body = await res.json();
    if (body.enabled) body.finished = finished.concat(body.finished || []);
    return route.fulfill({ response: res, json: body });
  });
  await p.open();
  const b = p.page.locator('#tasks > header h2 .fold');
  if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click();

  // Finished rows: OK all marks the three as seen at once, and they stay gone after a reload.
  const finishedRow = p.page.locator('.cc-ask', { hasText: /finished Review PR #\d/ });
  await until(async () => (await finishedRow.count()) === 3, 'three finished rows');
  await p.page.getByRole('button', { name: 'OK all' }).click();
  await finishedRow.first().waitFor({ state: 'detached' });
  assert.strictEqual(await p.page.getByRole('button', { name: 'OK all' }).count(), 0, 'no OK all with nothing to OK');
  const seen = JSON.parse(await p.page.evaluate(() => localStorage.getItem('office.finishedSeen')));
  assert.deepStrictEqual(finished.map((f) => f.id + f.at).filter((x) => !seen.includes(x)), [], 'each is kept as seen');

  // Leftover checkouts: two go, the one with ignored files stays and asks.
  const leftRow = (cwd) => p.page.locator('.cc-ask', { hasText: 'with nobody in it: ' + cwd });
  for (const c of plain.concat(kept)) await leftRow(c.cwd).waitFor();
  await p.page.locator('#office-notes').getByRole('button', { name: 'Clean up all' }).click();
  await p.page.locator('#cc-status', { hasText: 'Clean up all removed 2 checkouts. 1 holds files git ignores and asks before it deletes them.' }).waitFor();
  for (const c of plain) { await leftRow(c.cwd).waitFor({ state: 'detached' }); assert.strictEqual(fs.existsSync(c.cwd), false, c.cwd + ' is gone'); }
  const asking = p.page.locator('.cc-ask', { hasText: kept.cwd + ' holds files git ignores, and Clean up would delete them: secret.env' });
  await asking.waitFor();
  assert.ok(fs.existsSync(path.join(kept.cwd, 'secret.env')), 'the ignored file is still there');
  assert.strictEqual(await p.page.locator('#office-notes').getByRole('button', { name: 'Clean up all' }).count(), 0, 'one row left, so no Clean up all');
  await asking.getByRole('button', { name: 'Delete them too' }).click();
  await asking.waitFor({ state: 'detached' });
  assert.strictEqual(fs.existsSync(kept.cwd), false);

  // Done tasks: one click removes all three.
  const taskRow = (t) => p.page.locator('#task-rows li', { hasText: t.title });
  for (const t of tasks) await taskRow(t).getByRole('button', { name: 'Clean up' }).waitFor();
  await p.page.locator('#tasks').getByRole('button', { name: 'Clean up all' }).click();
  await p.page.locator('#task-note', { hasText: 'Clean up all removed 3 tasks.' }).waitFor();
  for (const t of tasks) { await taskRow(t).waitFor({ state: 'detached' }); assert.strictEqual(fs.existsSync(t.worktree), false, t.title + ' checkout is gone'); }
  assert.strictEqual((await o.R.call('GET', '/tasks')).body.tasks.length, 0);
  assert.deepStrictEqual((await o.R.call('GET', '/checkouts')).body.checkouts, []);
  assert.deepStrictEqual(errorsBut(p, 409, '/channels/t/checkouts/' + kept.id + '/clean'), [], 'only the 409 that asks about ignored files');
});
