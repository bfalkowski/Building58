// A red PR whose only failed checks are a known flaky test, as plain functions of what the relay already keeps, so the
// tests run them on made-up data. relay/flake.js gathers the state and carries the actions out. See
// docs/manual/roles.html#flake-rerun.
//
//   testsOf(log)   the failing tests a failed job's log names: { names, files }
//   knownBy(tickets, tests)   the open flaky ticket that names each failing test, or null if one is not named
//   decide({ failed, head, rec, seenNotRed })   what to do about a red head:
//     rerun   no rerun of this head yet and every failed check is known: rerun it once
//     second  it was rerun, a run since showed another state, and it is red again: no second rerun
//     wait    it was rerun and nothing new shows yet, or a failed check is not a known flake
'use strict';

const OPEN = ['triage', 'ready', 'started'];
const SPEC = /^\s*[✖✗×]\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/u;
const TAP = /^\s*not ok \d+ - (.+?)\s*(?:#.*)?$/;
const FILE = /([\w.-]+\.test\.js)\b/g;
const MIN_NAME = 8;

function testsOf(log) {
  const names = new Set(), files = new Set();
  for (const line of String(log || '').split('\n')) {
    const m = line.match(SPEC) || line.match(TAP);
    if (m && m[1].length >= MIN_NAME && !/\.test\.js$/.test(m[1]) && !/^(?:tests?|suites?|pass|fail)\b/i.test(m[1])) names.add(m[1].trim());
    for (const f of line.matchAll(FILE)) files.add(f[1]);
  }
  return { names: [...names], files: [...files] };
}

const flaky = (t) => t.kind === 'flaky' || (Array.isArray(t.labels) && t.labels.includes('flaky'));
const says = (t, text) => (String(t.title || '') + '\n' + String(t.body || '')).toLowerCase().includes(String(text).toLowerCase());
const titled = (t, text) => String(t.title || '').toLowerCase().includes(String(text).toLowerCase());

function knownBy(tickets, tests) {
  const open = (tickets || []).filter((t) => OPEN.includes(t.status));
  if (!tests || !tests.names.length) return null;
  const found = [];
  for (const name of tests.names) {
    const t = open.find((x) => (flaky(x) && says(x, name)) || titled(x, name))
      || (tests.files.length === 1 ? open.find((x) => (flaky(x) && says(x, tests.files[0])) || titled(x, tests.files[0])) : null);
    if (!t) return null;
    found.push(t);
  }
  return found[0];
}

function decide({ failed, head, rec, seenNotRed, known }) {
  if (!failed || !failed.length || !head) return { act: 'wait' };
  if (rec && rec.head === head) return seenNotRed || rec.seenNotRed ? { act: 'second', ticket: rec.ticket } : { act: 'wait' };
  return known ? { act: 'rerun', ticket: known } : { act: 'wait' };
}

module.exports = { testsOf, knownBy, decide, flaky, OPEN };
