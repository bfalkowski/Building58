// Exhibit runs on this repo's PRs once a night, in shadow mode: it stores a verdict for each PR and nothing
// waits on it (docs/manual/roles.html, Exhibit in shadow mode). It posts no comment on a PR, because the room
// tells a Dev about every new comment. These checks keep the workflow nightly and quiet, keep the job that
// runs a PR's code away from any write token, and keep the Exhibit code pinned by commit, so a change to
// any of these shows here and goes to a person.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const workflow = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'exhibit.yml'), 'utf8');
const code = workflow.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

function job(name) {
  const m = code.match(new RegExp('^  ' + name + ':\\n([\\s\\S]*?)(?=^  \\w[\\w-]*:\\n|(?![\\s\\S]))', 'm'));
  assert.ok(m, 'the workflow has a ' + name + ' job');
  return m[1];
}

test('the workflow runs on a schedule and by hand, never on a pull request', () => {
  const on = code.match(/^on:\n((?: {2}.*\n|\n)+)/m);
  assert.ok(on, 'the workflow has an on: block');
  assert.match(on[1], /^ {2}schedule:\n {4}- cron: '\d+ \d+ \* \* \*'$/m);
  assert.match(on[1], /^ {2}workflow_dispatch:/m);
  assert.doesNotMatch(code, /pull_request/);
  assert.doesNotMatch(code, /^\s*push:/m);
});

test('no job gets a permission it does not name, and only the publish job writes', () => {
  assert.match(code, /^permissions: \{\}$/m);
  assert.match(job('plan'), /permissions:\n {6}contents: read\n {6}pull-requests: read\n/);
  assert.match(job('check'), /permissions:\n {6}contents: read\n/);
  assert.doesNotMatch(job('check'), /: write/);
  assert.match(job('publish'), /permissions:\n(?: {6}#.*\n)* {6}contents: write\n {4}steps:/);
  assert.strictEqual((code.match(/: write/g) || []).length, 1, 'one write permission in the whole workflow');
});

test('it posts nothing on a PR: no comment, no pull-requests write, no gh comment', () => {
  assert.doesNotMatch(code, /--comment|pull-requests: write|gh pr (comment|review)|gh api|issues: write/);
});

test('it uses no secret, and it is in shadow mode', () => {
  assert.doesNotMatch(code, /secrets\./);
  assert.match(job('check'), /exhibit\.js" check [^\n]*--shadow/);
  assert.doesNotMatch(code, /--enforce|enforce: true/);
});

test('Exhibit is pinned by a full commit, fetched and checked in both jobs, never a tag, a branch, ./ or an Action', () => {
  const pin = code.match(/^ {2}EXHIBIT_COMMIT: ([0-9a-f]{40})$/m);
  assert.ok(pin, 'EXHIBIT_COMMIT is a 40-character commit');
  const uses = [...code.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(!uses.some((u) => u.startsWith('./') || u.startsWith('bfalkowski/')), 'no step uses ./ or the Exhibit Action');
  for (const name of ['check', 'publish']) {
    assert.match(job(name), /git fetch -q --depth 1 https:\/\/github\.com\/bfalkowski\/exhibit\.git "\$EXHIBIT_COMMIT"/, name + ' fetches the pinned commit');
    assert.match(job(name), /test "\$\(git rev-parse HEAD\)" = "\$EXHIBIT_COMMIT"/, name + ' checks that it got that commit');
  }
  assert.ok(workflow.includes(pin[1]), 'the comment names the release of that commit');
});

test('the publish job runs no code from a PR, and checks each exhibit against the plan before it stores it', () => {
  const publish = job('publish');
  assert.doesNotMatch(publish, /refs\/pull|pr\/\$/);
  assert.match(publish, /e\.pr === Number\(pr\) && e\.head === head/);
  assert.match(publish, /String\(e\.repo\)\.toLowerCase\(\) === repo\.toLowerCase\(\)/);
});

test('the check job takes a PR number and head only from the plan, in env, never pasted into a script', () => {
  const check = job('check');
  const lines = check.split('\n').filter((l) => l.includes('${{ matrix.'));
  assert.ok(lines.length >= 3);
  for (const l of lines) assert.match(l.trim(), /^(PR|HEAD_SHA): \$\{\{ matrix\.(pr|head) \}\}$|^name: (Exhibit check PR|exhibit-)[^\n]*\$\{\{ matrix\.pr \}\}$/, 'matrix values are used only in env and names');
  assert.match(check, /PR: \$\{\{ matrix\.pr \}\}/);
});

test('evidence.yml is a version 3 policy that does not turn enforcement on', () => {
  const policy = fs.readFileSync(path.join(REPO, 'evidence.yml'), 'utf8');
  assert.match(policy, /^version: 3$/m);
  assert.match(policy, /^kinds:$/m);
  assert.doesNotMatch(policy, /merge_without_reading:\s*allowed/);
});
