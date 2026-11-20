// T-199: The relay and ticket.js check a ticket when it is filed. A PM's body needs the four parts its
// brief asks for: What to build, Acceptance criteria, Blocked by and Out of scope. Other sessions and the
// person file any body. A --blocked-by id that no ticket has is refused, and so is a blocker list written
// with spaces, where the second id would join the title. Each refusal says what to fix, and files nothing.
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

const CLI = path.join(__dirname, '..', 'ticket.js');
const FOUR = 'What to build: a thing.\n\nAcceptance criteria:\n- it works\n\nBlocked by: none\n\nOut of scope: the rest.';

test('a ticket is checked when it is filed', async (t) => {
  const R = await H.relay({});
  t.after(R.stop);
  const repo = H.makeRepo(R.home);
  const start = async (extra) => (await R.call('POST', '/terminals', { cwd: repo, ...extra })).body;
  const tokenOf = (s) => H.until(() => { try { return { 'X-Office-Token': H.sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'the token');
  const worker = await start(), pm = await start({ role: 'pm', title: 'PM: an idea' });
  const workerT = await tokenOf(worker), pmT = await tokenOf(pm);
  const titles = async () => (await R.call('GET', '/tickets')).body.tickets.map((x) => x.title);
  const first = (await R.call('POST', '/tickets', { title: 'First', repo, body: 'Do it.' })).body.ticket.id;
  const second = (await R.call('POST', '/tickets', { title: 'Second', repo, body: 'Do it.' })).body.ticket.id;
  const cli = (token) => ({ ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: token['X-Office-Token'] });
  const fails = (token, args, input) => { try { execFileSync('node', [CLI, 'create', ...args], { env: cli(token), input, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { return e.stderr; } assert.fail('it filed: ' + args.join(' ')); };

  await t.test('a PM body without the four parts is refused, naming the parts it lacks', async () => {
    const r = await R.call('POST', '/tickets', { title: 'Half a body', body: 'What to build: a thing.\n\nOut of scope: the rest.' }, pmT);
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body.error, 'bad_body');
    assert.match(r.body.message, /What to build, Acceptance criteria, Blocked by and Out of scope/);
    assert.match(r.body.message, /Missing: Acceptance criteria, Blocked by\./);
    const none = await R.call('POST', '/tickets', { title: 'No body' }, pmT);
    assert.strictEqual(none.status, 400);
    assert.match(none.body.message, /Missing: What to build, Acceptance criteria, Blocked by, Out of scope\./);
    const inline = await R.call('POST', '/tickets', { title: 'Words in a line', body: 'Say what to build, the acceptance criteria, what it is blocked by and what is out of scope.' }, pmT);
    assert.strictEqual(inline.status, 400, 'a part starts its own line');
    for (const title of ['Half a body', 'No body', 'Words in a line']) assert.ok(!(await titles()).includes(title), title + ' was not filed');
  });

  await t.test('a PM body with the four parts is filed, as plain lines or markdown headings', async () => {
    assert.strictEqual((await R.call('POST', '/tickets', { title: 'Plain parts', body: FOUR }, pmT)).status, 201);
    const md = '## What to build\nA thing.\n\n**Acceptance criteria**\n- it works\n\n### blocked by\nNone\n\n- Out of scope: the rest.';
    const r = await R.call('POST', '/tickets', { title: 'Markdown parts', body: md }, pmT);
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.ticket.body, md);
  });

  await t.test('a worker and the person file any body', async () => {
    assert.strictEqual((await R.call('POST', '/tickets', { title: 'A follow-up', body: 'Fix the other thing.' }, workerT)).status, 201);
    assert.strictEqual((await R.call('POST', '/tickets', { title: 'A short one', repo, body: 'Do it.' })).status, 201);
  });

  await t.test('a blocker id no ticket has is refused, with how to find the ids', async () => {
    for (const who of [workerT, pmT]) {
      const r = await R.call('POST', '/tickets', { title: 'Waits on nothing', body: FOUR, blockedBy: [first, 'T-999'] }, who);
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.error, 'bad_blocker');
      assert.match(r.body.message, /No such ticket: T-999\. .*ticket\.js list/);
    }
    assert.ok(!(await titles()).includes('Waits on nothing'));
  });

  await t.test('an id with a space inside is refused as a list that needs commas', async () => {
    const r = await R.call('POST', '/tickets', { title: 'Spaced', body: FOUR, blockedBy: [first + ' ' + second] }, workerT);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'bad_blocker');
    assert.match(r.body.message, new RegExp('--blocked-by ' + first + ',' + second));
  });

  await t.test('ticket.js refuses blockers written with spaces, and files nothing', async () => {
    for (const ids of [[first, second], [first + ',', second], [first + ' ' + second], [first + ', ' + second]]) {
      const err = fails(workerT, ['Spaced from the tool', '--body', 'Do it.', '--blocked-by', ...ids]);
      assert.match(err, new RegExp('Write the ids after --blocked-by with commas and no spaces: --blocked-by ' + first + ',' + second + '\\.'), ids.join(' | '));
    }
    assert.match(fails(workerT, ['Spaced shapes', '--body', 'Do it.', '--shapes', first, second]), new RegExp('--shapes ' + first + ',' + second));
    const all = await titles();
    for (const title of ['Spaced from the tool', 'Spaced from the tool ' + second, 'Spaced shapes']) assert.ok(!all.includes(title), title + ' was not filed');
  });

  await t.test('ticket.js files blockers written with commas, and a title word after them', async () => {
    const out = execFileSync('node', [CLI, 'create', '--blocked-by', first + ',' + second, 'Waits', 'on', 'two', '--body', 'Do it.'], { env: cli(workerT), encoding: 'utf8' });
    const id = out.match(/Filed: (\S+) {2}Waits on two/)[1];
    assert.deepStrictEqual((await R.call('GET', '/tickets/' + id)).body.ticket.blockedBy, [first, second]);
  });

  await t.test('ticket.js shows the PM what its body lacks', async () => {
    const err = fails(pmT, ['From the PM', '--body', '-'], 'What to build: a thing.\n');
    assert.match(err, /Missing: Acceptance criteria, Blocked by, Out of scope\./);
  });
});
