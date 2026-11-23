'use strict';
// A follow-up review's prompt names an earlier PR of the ticket that was closed without a merge (T-297).
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-earlier-'));
process.env.GH_CMD = path.join(__dirname, 'fake-gh.js');
process.env.FAKE_GH_DIR = dir;
process.env.RELAY_GH_FRESH_MS = '0';
const test = require('node:test');
const assert = require('node:assert');
const history = require('../review-history.js');
const door = require('../gh.js');

const NOW = 'https://github.com/acme/widgets/pull/52', OLD = 'https://github.com/acme/widgets/pull/9';
const task = (notes) => ({ history: [{ type: 'pr', pr: OLD }, { type: 'pr', pr: NOW }].concat(notes) });
const answer = (pr) => fs.writeFileSync(path.join(dir, 'answers.json'), JSON.stringify({ prs: { [OLD]: pr } }));

test('a closed, unmerged earlier PR is named, with the note that names it and says it closed', async () => {
  answer({ state: 'CLOSED', mergedAt: null });
  const notes = [{ type: 'note', note: 'Unrelated: closed a desk.' }, { type: 'note', note: OLD + ' was closed: wrong approach.' }];
  const got = await history.earlierOf(task(notes), NOW, door.pr);
  assert.deepStrictEqual(got, { pr: OLD, why: OLD + ' was closed: wrong approach.' });
  const text = history.text([], { earlier: got });
  assert.ok(text.includes(OLD) && text.includes('closed without a merge'));
});

test('an earlier PR with no note that names it has no reason, and one that merged or is open is not named', async () => {
  answer({ state: 'CLOSED', mergedAt: null });
  assert.deepStrictEqual(await history.earlierOf(task([{ type: 'note', note: 'closed a desk' }]), NOW, door.pr), { pr: OLD, why: '' });
  answer({ state: 'MERGED', mergedAt: '2026-11-20T10:00:00Z' });
  assert.strictEqual(await history.earlierOf(task([]), NOW, (pr) => door.pr(pr)), null);
  assert.strictEqual(await history.earlierOf({ history: [{ type: 'pr', pr: NOW }] }, NOW, door.pr), null);
});
