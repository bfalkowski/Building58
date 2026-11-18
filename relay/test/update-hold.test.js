'use strict';
// What an update holds while it waits for a quiet moment (T-198). Autopilot pulls main after each
// merge, so in a busy office an update can wait for hours. The relay held every saved message and the
// Lead's brief for that whole wait. Now the Lead's brief goes in during the wait, like a task's brief
// (T-299) and a first prompt (T-147). Other saved messages are held only for RELAY_UPDATE_HOLD_MS from
// when the wait began, which gives the update a chance at a quiet moment, and then go in. The update
// then waits for their turns. Through a real relay, with a fake claude.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sleep } = require('./helpers.js');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, file, text, message) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  sh(cwd, 'add', file);
  sh(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message);
};
const BRIEF = 'GOT[You are the Lead of this room.', MENTION = 'GOT[The room chat board has new posts that mention you';
const HOLD = 8000;

test('an update that waits holds the Lead\'s brief not at all, and other saved messages only for a while', async (t) => {
  const R0 = await relay({});
  const home = R0.home;
  await R0.kill();
  const src = makeRepo(home, 'src'), relayOrigin = path.join(home, 'relay-origin.git'), dir = path.join(home, 'relay-folder');
  commit(src, 'relay/x.js', '1\n', 'relay file');
  sh(home, 'clone', '-q', '--bare', src, relayOrigin); sh(home, 'clone', '-q', relayOrigin, dir); sh(src, 'remote', 'add', 'origin', relayOrigin);
  const repo = makeRepo(home);

  const R = await relay({ RELAY_UPDATE_DIR: dir, RELAY_UPDATE_HOLD_MS: String(HOLD) }, home);
  t.after(async () => { await R.kill().catch(() => {}); await R.remove(); });
  const say = (sessionId, event) => R.hook({ hook_event_name: event, session_id: sessionId.slice(0, 12) });
  const update = async () => (await R.call('GET', '/update')).body;
  const count = async (id, what) => (await R.screen(id)).split(what).length - 1;
  const turn = async (s) => { await say(s.sessionId, 'UserPromptSubmit'); await say(s.sessionId, 'Stop'); };

  const lead = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await turn(lead);
  assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: lead.id })).body.lead, true);
  await until(async () => (await count(lead.id, BRIEF)) === 1, 'the Lead to get its brief');
  await turn(lead);
  const busy = (await R.call('POST', '/terminals', { cwd: repo })).body;
  await say(busy.sessionId, 'UserPromptSubmit');
  commit(src, 'relay/x.js', '2\n', 'relay change'); sh(src, 'push', '-q', 'origin', 'main');
  const u = await R.call('POST', '/update', {});
  assert.strictEqual(u.status, 202, JSON.stringify(u.body));
  const waitBegan = Date.now();

  await t.test('the Lead\'s brief goes in while the update waits', async () => {
    assert.strictEqual((await R.call('POST', '/settings', { values: { leadOrder: true } })).status, 200);
    await until(async () => (await count(lead.id, BRIEF)) === 2, 'the Lead to get its new brief while the update waits');
    assert.ok(Date.now() - waitBegan < HOLD, 'it went in before the hold ran out');
    assert.strictEqual((await update()).update.state, 'waiting');
    await turn(lead);
  });

  await t.test('a saved message is held while the update has waited less than the hold', async () => {
    assert.strictEqual((await R.call('POST', '/chat/office', { text: '@Lead look at this' })).status, 201);
    await sleep(2000);
    assert.ok(Date.now() - waitBegan < HOLD, 'the check ran inside the hold');
    assert.strictEqual(await count(lead.id, MENTION), 0, 'not typed yet');
  });

  await t.test('after the hold it goes in, and the update waits for its turn', async () => {
    await until(async () => (await count(lead.id, MENTION)) === 1, 'the mention to go in once the hold ran out');
    assert.ok(Date.now() - waitBegan >= HOLD, 'not before the hold ran out');
    await say(lead.sessionId, 'UserPromptSubmit');
    await say(busy.sessionId, 'Stop');
    await sleep(1500);
    const view = (await update()).update;
    assert.ok(view && view.state === 'waiting' && view.waitingOn.some((w) => w.terminal === lead.id && w.why === 'in a turn'), JSON.stringify(view));
  });
});
