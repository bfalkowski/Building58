#!/usr/bin/env node
// Reruns the PM-brief eval after the PM's brief changes (relay/pm-brief.js), and keeps the change only
// if the eval does not get worse (T-208).
//   node relay/pm-brief-eval.js --kit DIR [--api http://127.0.0.1:8021/api] [--project project_default]
// DIR is the eval kit: harness_note.txt, repo_notes.txt, rubric_v2.txt, and idea_a, idea_b, idea_c with
// board_empty, board_b, board_c. The API is an edd-platform with its suite gate, started with a live
// model key. In it this makes an agent with the kit's three tests, a version with the brief last judged
// (relay/pm-brief-eval.json) and one with the brief now, runs each version's suite live, and compares
// the two suites. If any test passed before and fails now, it exits 1 and the file stays as it was, so
// npm test keeps failing. Otherwise it writes the new brief and the result into the file. With no file
// yet, it runs the brief now alone and writes the first one. Exit 2 means the eval could not run.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { oneLine } = require('./clean.js');
const { forEval } = require('./pm-brief.js');

const STAMP = path.join(__dirname, 'pm-brief-eval.json');
const TESTS = [
  ['A', 'Walkthrough goal, empty board', 'idea_a.txt', 'board_empty.txt'],
  ['B', 'Re-map after HLD-007, board T-1 to T-17', 'idea_b.txt', 'board_b.txt'],
  ['C', 'Single bug: wizard-state 500', 'idea_c.txt', 'board_c.txt'],
];
const KIT = ['harness_note.txt', 'repo_notes.txt', 'rubric_v2.txt', ...new Set(TESTS.flatMap((t) => [t[2], t[3]]))];

class Stop extends Error {}

function options(argv) {
  const o = { api: 'http://127.0.0.1:8021/api', project: 'project_default', stamp: STAMP };
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--kit': 'kit', '--api': 'api', '--project': 'project', '--stamp': 'stamp' }[argv[i]];
    if (!key || argv[i + 1] === undefined) throw new Stop('Usage: node relay/pm-brief-eval.js --kit DIR [--api URL] [--project ID]');
    o[key] = argv[i + 1];
  }
  return o;
}

function caller(api, project) {
  const base = new URL(api.replace(/\/+$/, '') + '/projects/' + encodeURIComponent(project));
  return (method, route, body) => new Promise((done, fail) => {
    const url = new URL(base.pathname + route, base);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = (url.protocol === 'https:' ? https : http).request(url, { method, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return fail(new Stop(method + ' ' + route + ' answered ' + res.statusCode + ': ' + oneLine(text, 400)));
        try { done(text ? JSON.parse(text) : null); } catch (e) { fail(new Stop(method + ' ' + route + ' did not answer JSON.')); }
      });
    });
    req.on('error', (e) => fail(new Stop('Could not reach ' + url.origin + ': ' + e.message + '. Start edd-platform with its suite gate first.')));
    req.end(data);
  });
}

function readKit(dir) {
  if (!dir) throw new Stop('Name the eval kit with --kit DIR.');
  const missing = KIT.filter((f) => !fs.existsSync(path.join(dir, f)));
  if (missing.length) throw new Stop('The kit in ' + dir + ' has no ' + missing.join(', ') + '.');
  return (f) => fs.readFileSync(path.join(dir, f), 'utf8').trim();
}

async function makeTests(call, kit) {
  const agent = await call('POST', '/agent-designs', { name: 'PM brief eval', intent: 'Turn an idea into tickets that follow the PM ticket rules.' });
  const agentId = (agent.agent || agent).id;
  const checks = ['What to build', 'Acceptance criteria', 'Blocked by', 'Out of scope'].map((s) => ({ id: 'has_' + s.toLowerCase().replace(/ /g, '_'), type: 'output_contains', value: s }))
    .concat([
      { id: 'no_em_dash', type: 'output_not_contains', value: '\u2014' },
      { id: 'no_arrow', type: 'output_not_contains', value: '\u2192' },
      { id: 'no_checkbox', type: 'output_not_contains', value: '- [ ]' },
      { id: 'rubric_judge', type: 'rubric_judge', value: kit('rubric_v2.txt') },
    ]);
  const contract = (extra) => ({ agent_design_id: agentId, name: 'PM ticket rules (strict)', status: 'active', description: 'Rules every PM ticket must follow.',
    expected_behavior: ['Files tickets that follow the PM ticket rules for the given idea and board.'], checks, pass_criteria: 'all_checks_pass', ...extra });
  const shared = await call('POST', '/eval-contracts', contract({}));
  const names = {};
  for (const [key, name, idea, board] of TESTS) {
    const s = await call('POST', '/scenarios', { agent_design_id: agentId, name, status: 'active', input: kit('harness_note.txt') + '\n\n' + kit(idea),
      setup_context: kit('repo_notes.txt') + '\n\n' + kit(board), default_eval_contract_id: shared.id });
    await call('POST', '/eval-contracts', contract({ scenario_id: s.id, name: 'PM ticket rules (strict) ' + key }));
    names[s.id] = key;
  }
  return { agentId, names };
}

async function suite(call, agentId, label, instructions, status) {
  const v = await call('POST', '/agent-designs/' + agentId + '/versions', { version_label: label, instructions, status });
  const result = await call('POST', '/agent-designs/' + agentId + '/versions/' + v.id + '/suite-runs', { mode: 'live', judge_mode: 'live' });
  const unjudged = result.tests.filter((t) => !t.eval_result);
  if (unjudged.length) throw new Stop('The suite of ' + label + ' has no eval for ' + unjudged.map((t) => t.scenario_id).join(', ') + '.');
  return { id: v.id, result };
}

async function evaluate(o, log) {
  const stamp = fs.existsSync(o.stamp) ? JSON.parse(fs.readFileSync(o.stamp, 'utf8')) : null;
  const brief = forEval();
  if (stamp && stamp.brief === brief) { log('The PM brief is the one the eval last judged. Nothing to run.'); return 0; }
  const kit = readKit(o.kit);
  const call = caller(o.api, o.project);
  const { agentId, names } = await makeTests(call, kit);
  const before = stamp && await suite(call, agentId, 'judged', stamp.brief, 'baseline');
  const now = await suite(call, agentId, 'changed', brief, before ? 'candidate' : 'baseline');
  const cmp = before && await call('POST', '/comparisons/suite', { baseline_version_id: before.id, candidate_version_id: now.id });
  const outcome = new Map(((cmp && cmp.tests) || []).map((r) => [r.scenario_id, r.outcome]));
  const tests = now.result.tests.map((t) => ({ test: names[t.scenario_id] || t.scenario_id, passed: !!t.eval_result.passed, score: t.eval_result.score, ...(cmp ? { outcome: outcome.get(t.scenario_id) } : {}) }));
  for (const t of tests) log(t.test + ': ' + (t.passed ? 'passed' : 'failed') + ', score ' + t.score + (t.outcome ? ', ' + t.outcome.replace('_', ' ') : ''));
  log('Passed ' + now.result.passed + ' of ' + now.result.total + (before ? ', was ' + before.result.passed + ' of ' + before.result.total : '') + '.');
  if (cmp && cmp.totals.regressed > 0) {
    log('The eval got worse: ' + cmp.totals.regressed + ' test(s) passed with the brief last judged and fail now. ' + path.basename(o.stamp) + ' stays as it was, so npm test still fails.');
    return 1;
  }
  const judged = { on: new Date().toISOString().slice(0, 10), passed: now.result.passed, total: now.result.total, tests };
  if (cmp) Object.assign(judged, { before: before.result.passed, comparison: cmp.id, totals: cmp.totals });
  fs.writeFileSync(o.stamp, JSON.stringify({ brief, judged }, null, 2) + '\n');
  log('The eval did not get worse. Wrote the brief and the result to ' + path.basename(o.stamp) + '; commit it with the change.');
  return 0;
}

if (require.main === module) {
  Promise.resolve().then(() => evaluate(options(process.argv.slice(2)), console.log)).then((code) => { process.exitCode = code; }, (e) => {
    console.error(e instanceof Stop ? e.message : e.stack);
    process.exitCode = 2;
  });
}

module.exports = { evaluate, options, STAMP };
