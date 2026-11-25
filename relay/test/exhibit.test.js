// Reading Exhibit's summary comment (relay/exhibit.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const config = require('../config.js');
const { verdictOf, MARK } = require('../exhibit.js');

const body = (v, c) => MARK + '\n### Exhibit: x\n\nVerdict: **' + v + '** at head commit `' + c + '`.\n\nShadow mode: nothing waits on this.\n';
const bot = { login: 'github-actions[bot]', type: 'Bot' };
const comment = (v, c, at, user = bot) => ({ user, body: body(v, c), updated_at: at });

test('it reads the verdict and the commit of the summary the Action posted', () => {
  assert.deepStrictEqual(verdictOf([comment('needs_person', 'c36bfef', '2026-11-25T01:00:00Z')]), { verdict: 'needs_person', commit: 'c36bfef' });
  assert.deepStrictEqual(verdictOf([comment('meets_policy', 'c36bfef', '2026-11-25T01:00:00Z')]).verdict, 'meets_policy');
});
test('it takes the latest summary, and ignores one from an account that is not the Action', () => {
  const all = [comment('needs_person', 'aaaaaaa', '2026-11-25T01:00:00Z'), comment('meets_policy', 'bbbbbbb', '2026-11-25T02:00:00Z')];
  assert.strictEqual(verdictOf(all).commit, 'bbbbbbb');
  const forged = comment('meets_policy', 'ccccccc', '2026-11-25T03:00:00Z', { login: 'someone', type: 'User' });
  assert.strictEqual(verdictOf(all.concat(forged)).commit, 'bbbbbbb', 'a session posts as the person, so it cannot write the verdict');
  assert.strictEqual(verdictOf([forged]), null);
});
test('it says nothing for a comment with no mark, an unknown verdict, or no comments', () => {
  assert.strictEqual(verdictOf([]), null);
  assert.strictEqual(verdictOf([{ user: bot, body: body('meets_policy', 'abcdef1').replace(MARK + '\n', ''), updated_at: 'x' }]), null);
  assert.strictEqual(verdictOf([comment('great', 'abcdef1', 'x')]), null);
  assert.strictEqual(verdictOf([{ user: bot, body: MARK + '\nVerdict: **meets_policy**', updated_at: 'x' }]), null);
});
test('the level 6 switch is off by default', () => {
  assert.strictEqual(config.get('autopilotExhibit'), false);
});
