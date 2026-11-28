// When CI goes red under a merge verdict, the Dev is told once and one jam is logged (relay/autopilot.js tellRedCi, relay/push-hold.js).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-red-ci-')));
Object.assign(process.env, { RELAY_DELIVERIES_FILE: path.join(home, 'deliveries.json'), RELAY_JAMS_FILE: path.join(home, 'jams.json'), RELAY_SETTINGS_FILE: path.join(home, 'settings.json') });
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const autopilot = require('../autopilot.js');
const delivery = require('../delivery.js');
const jams = require('../jams.js');
const hold = require('../push-hold.js');

test('the Dev is told CI is red once, and one push-hold-red-ci jam is logged', () => {
  const repo = path.join(home, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const PR = 'https://github.com/acme/widgets/pull/7';
  const task = { id: 't1', ticket: 'T-9', pr: PR, state: 'in_review', base: 'main', worktree: repo, owner: { terminal: 'term-1' } };
  const verdict = { kind: 'merge', commit: 'abc1234abc1234', posted: PR + '#issuecomment-1' };
  hold.sync(task, verdict, { state: 'red', failing: true, open: true });
  autopilot.tellRedCi('c', task);
  autopilot.tellRedCi('c', task);
  const sent = delivery.pending('c').filter((d) => d.key === 'red-ci-lift ' + PR);
  assert.strictEqual(sent.length, 1);
  assert.doesNotMatch(JSON.stringify(sent), /finding/);
  assert.deepStrictEqual(jams.listOf('c').filter((j) => j.kind === 'push-hold-red-ci').length, 1);
  assert.strictEqual(hold.untoldLift(task), null);
});
