'use strict';
// The manager's watch through a real relay (relay/manager-watch.js): a sign of stuck work becomes one note and one
// ticket in Triage labelled manager, never a second while the problem lasts, and the watch changes nothing it reads.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { relay, makeRepo, until, removeDir } = require('./helpers.js');

const ENV = { RELAY_MANAGER_WATCH_SECONDS: '1', RELAY_MANAGER_BUILDING_MS: '100', RELAY_MANAGER_SLOT_MS: '100', RELAY_MANAGER_BRIEF_MS: '3600000' };

test('the manager notes a task that stopped moving, files one ticket, and a stopped Dev is a second note', async (t) => {
  const R = await relay(ENV), { call } = R, repo = makeRepo(R.home);
  t.after(R.stop);
  const notes = async () => (await call('GET', '/manager')).body.notes;
  const mine = async () => (await call('GET', '/tickets')).body.tickets.filter((x) => (x.labels || []).includes('manager'));

  const ticket = (await call('POST', '/tickets', { title: 'Make a.txt say hello', body: 'Change a.txt.', repo })).body.ticket;
  const task = (await call('POST', '/tickets/' + ticket.id + '/start', {})).body.task;
  const before = JSON.stringify((await call('GET', '/tasks/' + task.id)).body.task.state);

  const quiet = await until(async () => (await notes()).find((n) => n.kind === 'quiet'), 'the note about a quiet task');
  assert.strictEqual(quiet.ticket, ticket.id);
  assert.strictEqual(quiet.terminal, task.worker.terminal);
  assert.match(quiet.reason, new RegExp(ticket.id + ' is in Building, and no hook, push or PR change came'));
  assert.ok(quiet.say.length > 0 && quiet.say.length <= 140);

  const filed = await until(async () => (await mine())[0], 'the manager\'s ticket');
  assert.strictEqual(filed.status, 'triage');
  assert.strictEqual(filed.createdBy, 'Manager');
  assert.match(filed.title, new RegExp('^' + ticket.id + ': '));
  assert.match(filed.body, /no hook, push or PR change/);
  assert.strictEqual((await notes()).find((n) => n.kind === 'quiet').filed, filed.id);

  const seq = (await notes()).slice(-1)[0].seq;
  const looks = (await call('GET', '/manager')).body.looks;
  await until(async () => (await call('GET', '/manager')).body.looks >= looks + 2, 'two more looks');
  assert.deepStrictEqual((await notes()).filter((n) => n.kind === 'quiet').length, 1, 'one note while it lasts');
  assert.strictEqual((await notes()).slice(-1)[0].seq, seq);
  assert.strictEqual((await mine()).filter((x) => x.title.startsWith(ticket.id + ': ') && /moved/.test(x.title)).length, 1, 'one ticket while it lasts');
  assert.strictEqual(JSON.stringify((await call('GET', '/tasks/' + task.id)).body.task.state), before, 'the task is as it was');

  await call('POST', '/terminals/' + task.worker.terminal + '/stop', {});
  const slot = await until(async () => (await notes()).find((n) => n.kind === 'slot'), 'the note about a slot with no Dev');
  assert.match(slot.reason, new RegExp(ticket.id + ' holds a building slot with no Dev'));
  await until(async () => (await mine()).length >= 2, 'a ticket for the slot');
  assert.strictEqual((await call('GET', '/tasks/' + task.id)).body.task.state, 'building', 'the watch did not move the task');

  assert.strictEqual((await call('GET', '/manager', undefined, { 'X-Office-Token': 'nope' })).status, 401);
});

test('the watch is off at 0, and its limits are on the route', async (t) => {
  const R = await relay({ RELAY_MANAGER_WATCH_SECONDS: '' }), { call } = R;
  t.after(R.stop);
  const got = (await call('GET', '/manager')).body;
  assert.strictEqual(got.on, false);
  assert.deepStrictEqual(got.notes, []);
  assert.strictEqual(got.limits.buildingMinutes, 60);
});

test('a check that fails on three commits in a row is a note, and a pass starts the count again', async (t) => {
  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  const R = await relay({ GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: ghDir, RELAY_GH_FRESH_MS: '0', RELAY_MANAGER_WATCH_SECONDS: '1', RELAY_MANAGER_BUILDING_MS: '3600000000', RELAY_MANAGER_SLOT_MS: '3600000000', RELAY_MANAGER_CHECK_FAILS: '3' }), { call } = R;
  t.after(async () => { await R.stop(); removeDir(ghDir); });
  const repo = makeRepo(R.home), PR = 'https://github.com/acme/widgets/pull/7';
  const answer = (head, conclusion) => fs.writeFileSync(path.join(ghDir, 'answers.json'), JSON.stringify({ prs: { [PR]: { state: 'OPEN', headRefOid: head, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: conclusion === 'ABSENT' ? [] : [{ name: 'pipeline', status: 'COMPLETED', conclusion }] } } }));
  const notes = async () => (await call('GET', '/manager')).body.notes.filter((n) => n.kind === 'check');
  const ticket = (await call('POST', '/tickets', { title: 'Make a.txt say hello', body: 'Change a.txt.', repo })).body.ticket;
  const task = (await call('POST', '/tickets/' + ticket.id + '/start', {})).body.task;
  const sid = task.worker.sessionId || (await call('GET', '/terminals')).body.terminals.find((x) => x.id === task.worker.terminal).sessionId;
  answer('a'.repeat(40), 'FAILURE');
  await R.hook({ hook_event_name: 'PostToolUse', session_id: sid.slice(0, 12), pr_url: PR });
  const commits = async () => ((await call('GET', '/manager')).body.checks.find((c) => c.pr === PR) || { commits: 0 }).commits;
  const seen = async (head, commitsNow, conclusion) => { answer(head, conclusion || 'FAILURE'); await until(async () => (await commits()) === commitsNow, 'the look at ' + head.slice(0, 1)); };
  await seen('b'.repeat(40), 1);
  await seen('c'.repeat(40), 2);
  assert.deepStrictEqual(await notes(), [], 'two failed commits are not enough');
  await seen('d'.repeat(40), 3);
  const [n] = await until(async () => { const l = await notes(); return l.length && l; }, 'the note about the check');
  assert.strictEqual(n.ticket, ticket.id);
  assert.match(n.reason, /The check pipeline failed on 3 commits of the PR of /);
  await seen('e'.repeat(40), 4);
  assert.strictEqual((await notes()).length, 1, 'one note while it lasts');
  assert.strictEqual((await call('GET', '/manager')).body.open.length, 1);
  await seen('f'.repeat(40), 0, 'SUCCESS');
  assert.strictEqual((await call('GET', '/manager')).body.open.length, 0, 'a pass ends it');
  await seen('1'.repeat(40), 1);
  await seen('2'.repeat(40), 2);
  assert.strictEqual((await notes()).length, 1, 'two failures after a pass are not three');
  await seen('3'.repeat(40), 0, 'ABSENT');
  await seen('4'.repeat(40), 1);
  assert.strictEqual((await notes()).length, 1, 'a check absent from a commit starts the count again');
});
