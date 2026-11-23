// Standing rules (relay/rules.js): the person keeps a list in Settings, and every brief the relay types
// for a new Dev, reviewer, Lead or PM ends with the rules in force. A session reads the list and cannot
// change it. The list outlives a restart.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, makeRepo, until, sessionToken } = require('./helpers.js');

const RULE = { text: 'Do not touch the payments folder.', reason: 'A release is frozen.', until: null };
const HEAD = 'Standing rules from the person, in force now.';
const NEVER = 'A standing rule never overrides CLAUDE.md or the constitution';
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

async function typed(R, id, start) {
  const screen = await until(async () => { const s = await R.screen(id); return s.includes(start) && s; }, 'the brief');
  const from = screen.lastIndexOf(start);
  return screen.slice(from, screen.indexOf(']', from));
}

test('each new brief carries the rules in force, and none changes it', async (t) => {
  const R = await relay({ RELAY_WIP_LIMIT: '5' });
  t.after(R.stop);
  const repo = makeRepo(R.home), origin = path.join(R.home, 'origin.git');
  sh(R.home, 'init', '-q', '--bare', origin);
  fs.writeFileSync(path.join(R.home, '.gitconfig'), '[url "' + origin + '"]\n\tinsteadOf = https://github.com/acme/widgets.git\n');
  sh(repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  sh(repo, 'push', '-qf', origin, 'HEAD:refs/pull/9/head');

  const dev = async (title) => { const task = (await R.call('POST', '/tasks', { title, repo })).body.task; return typed(R, task.owner.terminal, 'GOT[Your task is to build'); };
  const reviewer = async () => { const c = await R.call('POST', '/checkouts', { from: repo, pr: 'https://github.com/acme/widgets/pull/9', prompt: 'Review PR 9.' }); assert.strictEqual(c.status, 201, JSON.stringify(c.body)); return typed(R, c.body.id, 'GOT[Review PR 9.'); };
  const pm = async () => { const p = await R.call('POST', '/tickets/ask', { idea: 'an idea', repo }); assert.strictEqual(p.status, 201, JSON.stringify(p.body)); return typed(R, p.body.terminal, 'GOT[You are the product manager'); };
  const lead = async () => { const l = (await R.call('POST', '/terminals', { cwd: repo })).body; assert.strictEqual((await R.call('POST', '/terminals/lead', { terminal: l.id })).status, 200); return typed(R, l.id, 'GOT[You are the Lead'); };

  const before = { dev: await dev('One'), reviewer: await reviewer(), pm: await pm(), lead: await lead() };
  for (const [who, brief] of Object.entries(before)) assert.ok(!brief.includes(HEAD) && !brief.includes('payments'), who + ' brief with no rules is unchanged');

  const added = await R.call('POST', '/rules', RULE);
  assert.strictEqual(added.status, 201, JSON.stringify(added.body));
  const after = { dev: await dev('Two'), reviewer: await reviewer(), pm: await pm(), lead: await lead() };
  for (const [who, brief] of Object.entries(after)) {
    assert.ok(brief.includes(HEAD), who + ' has the heading');
    assert.ok(brief.includes(RULE.text) && brief.includes(RULE.reason), who + ' has the rule and its reason');
    assert.ok(brief.includes(NEVER), who + ' says it never overrides CLAUDE.md or the constitution');
    assert.strictEqual(brief.split(HEAD).length, 2, who + ' has one heading');
  }
  assert.ok(after.dev.indexOf('Do not merge it.') < after.dev.indexOf(HEAD), 'the rules come after the brief\'s own text');

  // A rule past its date is left out of new briefs and shows as ended.
  const old = await R.call('POST', '/rules', { text: 'Freeze the docs folder.', reason: 'Old reason.', until: '2020-01-01' });
  assert.strictEqual(old.status, 201);
  const listed = (await R.call('GET', '/rules')).body.rules;
  assert.deepStrictEqual(listed.map((r) => [r.text, r.ended]), [[RULE.text, false], ['Freeze the docs folder.', true]]);
  const third = await dev('Three');
  assert.ok(third.includes(RULE.text) && !third.includes('Freeze the docs folder.'), 'an ended rule is out of the brief');

  // The list keeps through a restart.
  await R.kill();
  const R2 = await relay({ RELAY_WIP_LIMIT: '5' }, R.home);
  t.after(R2.stop);
  assert.deepStrictEqual((await R2.call('GET', '/rules')).body.rules.map((r) => r.text), [RULE.text, 'Freeze the docs folder.']);

  // A rule is changed and removed, and bad input is refused.
  const id = listed[0].id;
  assert.strictEqual((await R2.call('POST', '/rules/' + id, { reason: 'It froze again.' })).body.rule.reason, 'It froze again.');
  for (const body of [{ text: '', reason: 'x' }, { text: 'x', reason: '' }, { text: 'x', reason: 'y', until: 'Friday' }, { text: 'x'.repeat(201), reason: 'y' }]) assert.strictEqual((await R2.call('POST', '/rules', body)).status, 400, JSON.stringify(body).slice(0, 60));
  assert.strictEqual((await R2.call('POST', '/rules/R-nope/remove')).status, 404);
  assert.strictEqual((await R2.call('POST', '/rules/' + id + '/remove')).status, 200);
  assert.deepStrictEqual((await R2.call('GET', '/rules')).body.rules.map((r) => r.text), ['Freeze the docs folder.']);
});

test('a session\'s token reads the rules and is refused for add, change and remove', async (t) => {
  const R = await relay({});
  t.after(R.stop);
  const repo = makeRepo(R.home);
  const rule = (await R.call('POST', '/rules', RULE)).body.rule;
  const kinds = [{}, { role: 'reviewer', pr: 'https://github.com/o/r/pull/7', title: 'Review' }, { role: 'pm', title: 'PM: an idea' }];
  for (const extra of kinds) {
    const s = (await R.call('POST', '/terminals', { cwd: repo, ...extra })).body;
    const token = await until(() => { try { return { 'X-Office-Token': sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'the token');
    const read = await R.call('GET', '/rules', undefined, token);
    assert.deepStrictEqual([read.status, read.body.rules.length], [200, 1], 'reading is allowed');
    for (const [path_, body] of [['/rules', RULE], ['/rules/' + rule.id, { text: 'Changed.' }], ['/rules/' + rule.id + '/remove', {}]]) {
      const r = await R.call('POST', path_, body, token);
      assert.deepStrictEqual([r.status, r.body.error], [403, 'person_only'], (extra.role || 'dev') + ' ' + path_);
    }
  }
  assert.deepStrictEqual((await R.call('GET', '/rules')).body.rules.map((r) => r.text), [RULE.text], 'nothing changed');
});

test('ten rules of the longest size keep a brief small', async (t) => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-rules-'));
  process.env.RELAY_RULES_FILE = path.join(dir, 'rules.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rules = require('../rules.js');
  const was = rules.list().length;
  assert.strictEqual(was, 0);
  for (let i = 0; i < rules.MAX_RULES; i++) assert.strictEqual(rules.add({ text: 't'.repeat(200), reason: 'r'.repeat(200), until: null })[0], 201);
  assert.strictEqual(rules.add({ text: 'one more', reason: 'r' })[0], 409);
  assert.ok(rules.brief().length < 5000, 'the rules add ' + rules.brief().length + ' characters at most');
});

test('a rule holds through its last day, and the brief reads the same whether or not the text ends with a period', async (t) => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'office-rules-'));
  process.env.RELAY_RULES_FILE = path.join(dir, 'rules.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rules = require('../rules.js');
  for (const r of rules.list()) rules.remove(r.id);
  const noon = (y, m, d) => new Date(y, m - 1, d, 12);
  rules.add({ text: 'No period here', reason: 'Ends with one.', until: '2026-06-10' });
  assert.deepStrictEqual([rules.list(noon(2026, 6, 10))[0].ended, rules.brief(noon(2026, 6, 10)).includes('No period here')], [false, true], 'in force on its last day');
  assert.deepStrictEqual([rules.list(noon(2026, 6, 11))[0].ended, rules.brief(noon(2026, 6, 11))], [true, ''], 'ended the day after');
  assert.match(rules.brief(noon(2026, 6, 10)), /1\. No period here\. Why: Ends with one\. Holds through 2026-06-10\./);
});
