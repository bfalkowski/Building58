'use strict';
// One state of the room, read three ways: the Needs you list (GET /needs-you), the huddle headline
// (POST /huddle) and the Board's Waiting on you column (GET /tickets with office/board-model.js) must count
// the same things. relay/needs-you-plan.js is the one rule for all three.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, sleep, until } = require('./helpers.js');
const M = require('../../office/board-model.js');

test('Needs you, the huddle and the Board agree', async (t) => {
  const gh = fs.mkdtempSync(path.join(os.tmpdir(), 'office-agree-gh-'));
  const R = await relay({ RELAY_WIP_LIMIT: '5', GH_CMD: path.join(__dirname, 'fake-gh.js'), FAKE_GH_DIR: gh, RELAY_HUDDLE_ANSWER_SECONDS: '4' });
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); fs.rmSync(gh, { recursive: true, force: true }); });
  const repo = makeRepo(R.home);
  const hook = async (s, event) => { await R.hook({ session_id: s.sessionId.slice(0, 12), ...event }); await sleep(150); };
  const terminals = async () => (await R.call('GET', '/terminals')).body.terminals;
  async function started(title) {
    const ticket = (await R.call('POST', '/tickets', { title, body: 'Do it.', repo })).body.ticket;
    await R.call('POST', '/tickets/' + ticket.id + '/move', { to: 'ready' });
    const r = await R.call('POST', '/tickets/' + ticket.id + '/start', {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const dev = (await terminals()).find((x) => x.id === r.body.task.owner.terminal);
    await until(async () => (await R.screen(dev.id)).includes('GOT['), 'the brief of ' + title);
    await hook(dev, { hook_event_name: 'UserPromptSubmit', title: '' });
    return { ticket: ticket.id, task: r.body.task.id, dev };
  }

  const stopped = await started('Stopped with no PR');
  await hook(stopped.dev, { hook_event_name: 'Stop' });
  const busy = await started('In Waiting on you, its Dev at work');
  await R.call('POST', '/tasks/' + busy.task + '/move', { to: 'waiting_on_you' });
  const look = await started('In Waiting on you, its Dev idle');
  await hook(look.dev, { hook_event_name: 'Stop' });
  await R.call('POST', '/tasks/' + look.task + '/move', { to: 'waiting_on_you' });

  const needs = (await R.call('GET', '/needs-you')).body;
  const huddle = (await R.call('POST', '/huddle', {})).body.report;
  const board = (await R.call('GET', '/tickets')).body.tickets;
  const column = (id) => board.filter((x) => M.columnOf(x) === id).map((x) => x.id).sort();

  await t.test('the same state gives the same count three times', () => {
    assert.deepStrictEqual(needs.items.map((i) => [i.kind, i.ticket]), [['waiting', look.ticket], ['prompt', stopped.ticket]]);
    assert.match(huddle.headline, /^2 need you,/);
    assert.strictEqual(column('waiting_on_you').length, needs.count);
  });
  await t.test('the Board\'s column holds the tickets Needs you lists, and the huddle flags their rows', () => {
    assert.deepStrictEqual(column('waiting_on_you'), needs.items.map((i) => i.ticket).sort());
    assert.deepStrictEqual(huddle.rows.filter((r) => r.needs).map((r) => r.ticket).sort(), needs.items.map((i) => i.ticket).sort());
    assert.strictEqual(huddle.rows.find((r) => r.ticket === look.ticket).needs, needs.items[0].line);
  });
  await t.test('a task in Waiting on you that needs no look shows where its work is', () => {
    assert.ok(column('building').includes(busy.ticket), 'its Dev is at work');
  });
});
