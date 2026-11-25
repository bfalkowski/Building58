// T-208: the PM-brief eval reruns whenever the PM's brief changes, and the change fails if the eval
// gets worse. npm test holds the brief to the text the eval last judged (relay/pm-brief-eval.json).
// relay/pm-brief-eval.js reruns the eval, here against a fake edd-platform suite gate, and writes a
// new text there only when no test that passed before fails now.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { forEval } = require('../pm-brief.js');
const { evaluate, STAMP } = require('../pm-brief-eval.js');

test('the PM brief is the one the eval last judged', () => {
  const stamp = JSON.parse(fs.readFileSync(STAMP, 'utf8'));
  assert.ok(stamp.brief === forEval(), 'The PM brief changed since the eval last judged it. Run npm run pm-brief-eval -- --branch NAME --push on the computer with the model key, '
    + 'or node relay/pm-brief-eval.js --kit DIR against edd-platform, and commit relay/pm-brief-eval.json if the eval did not get worse (docs/manual/roles.html#pm-brief-eval).');
});

test('the PM brief asks the PM to mark tickets that change the same code as blocked', () => {
  const brief = forEval();
  assert.match(brief, /same behavior or the same part of the relay or room/);
  assert.ok(brief.includes('node relay/ticket.js blockers ID --blocked-by ID --why'), 'names the command');
  assert.match(brief, /Mark only a clear overlap/);
  assert.match(brief, /keep the blockers it has/);
  assert.ok(brief.includes('node relay/ticket.js show ID'), 'says how to read the blockers');
  assert.match(brief, /later one as blocked by the earlier/);
});

test('the judged brief holds nothing from this computer', () => {
  const brief = forEval();
  assert.ok(!brief.includes(os.homedir()) && !brief.includes(__dirname), 'no path of this checkout');
  assert.ok(brief.includes('node relay/ticket.js create'), brief);
  assert.doesNotMatch(brief, /Use these skills/, 'no skills from this person\'s settings');
  assert.ok(brief.includes('Do not run ticket.js priority or order'), 'the PM as it starts: the order switch off');
});

function fakeEdd(passes) {
  const calls = [], versions = {}, scenarios = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const b = body ? JSON.parse(body) : null, route = req.url.replace('/api/projects/project_default', '');
      calls.push(req.method + ' ' + route.replace(/[a-z]+_\d+/g, 'ID'));
      const send = (x) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(x)); };
      const id = (p) => p + '_' + (++n);
      if (route === '/agent-designs') return send({ agent: { id: id('agent') } });
      if (route === '/eval-contracts') return send({ id: id('contract') });
      if (route === '/scenarios') { const s = { id: id('scenario') }; scenarios.push(s.id); return send(s); }
      if (/\/versions$/.test(route)) { const v = { id: id('version'), label: b.version_label, instructions: b.instructions }; versions[v.id] = v; return send(v); }
      const run = /\/versions\/([^/]+)\/suite-runs$/.exec(route);
      const suiteOf = (vid) => {
        const pass = passes[versions[vid].label];
        const tests = scenarios.map((s, i) => ({ scenario_id: s, eval_result: { passed: pass[i], score: pass[i] ? 8 : 5 } }));
        return { passed: tests.filter((t) => t.eval_result.passed).length, total: tests.length, tests };
      };
      if (run) return send(suiteOf(run[1]));
      if (route === '/comparisons/suite') {
        const a = suiteOf(b.baseline_version_id).tests, c = suiteOf(b.candidate_version_id).tests;
        const tests = c.map((t, i) => ({ scenario_id: t.scenario_id, outcome: [['still_failing', 'fixed'], ['regressed', 'still_passing']][+a[i].eval_result.passed][+t.eval_result.passed] }));
        const totals = { total: tests.length };
        for (const k of ['fixed', 'regressed', 'still_passing', 'still_failing']) totals[k] = tests.filter((t) => t.outcome === k).length;
        return send({ id: 'comparison_1', tests, totals });
      }
      res.statusCode = 404;
      send({ detail: 'Not Found' });
    });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ calls, versions, api: 'http://127.0.0.1:' + server.address().port + '/api', stop: () => server.close() })));
}

function setup(t, stamp) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-brief-eval-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const kit = path.join(dir, 'kit');
  fs.mkdirSync(kit);
  for (const f of ['harness_note', 'repo_notes', 'rubric_v2', 'idea_a', 'idea_b', 'idea_c', 'board_empty', 'board_b', 'board_c']) fs.writeFileSync(path.join(kit, f + '.txt'), f + '\n');
  const file = path.join(dir, 'pm-brief-eval.json');
  if (stamp) fs.writeFileSync(file, JSON.stringify(stamp));
  const lines = [];
  return { kit, file, lines, log: (l) => lines.push(l), read: () => fs.readFileSync(file, 'utf8') };
}

test('a brief the eval already judged runs nothing', async (t) => {
  const s = setup(t, { brief: forEval() });
  const edd = await fakeEdd({});
  t.after(edd.stop);
  assert.strictEqual(await evaluate({ kit: s.kit, api: edd.api, project: 'project_default', stamp: s.file }, s.log), 0);
  assert.deepStrictEqual(edd.calls, []);
  assert.match(s.lines.join('\n'), /Nothing to run/);
});

test('a changed brief that fails a test the old one passed is worse: exit 1, the judged text stays', async (t) => {
  const s = setup(t, { brief: 'the old brief' });
  const before = s.read();
  const edd = await fakeEdd({ judged: [true, false, true], changed: [true, true, false] });
  t.after(edd.stop);
  assert.strictEqual(await evaluate({ kit: s.kit, api: edd.api, project: 'project_default', stamp: s.file }, s.log), 1);
  assert.strictEqual(s.read(), before, 'npm test keeps failing');
  const labels = Object.values(edd.versions).map((v) => [v.label, v.instructions]);
  assert.deepStrictEqual(labels, [['judged', 'the old brief'], ['changed', forEval()]], 'both briefs run in the same suite');
  assert.ok(edd.calls.includes('POST /comparisons/suite'), 'edd-platform\'s suite comparison decides');
  assert.strictEqual(edd.calls.filter((c) => c === 'POST /scenarios').length, 3, 'the kit\'s three tests');
  assert.strictEqual(edd.calls.filter((c) => c === 'POST /eval-contracts').length, 4, 'a contract on each test, so the suite counts it');
  const out = s.lines.join('\n');
  assert.match(out, /C: failed, score 5, regressed/);
  assert.match(out, /B: passed, score 8, fixed/);
  assert.match(out, /The eval got worse: 1 test\(s\)/);
});

test('a changed brief that loses no test is kept, with what the eval found', async (t) => {
  const s = setup(t, { brief: 'the old brief' });
  const edd = await fakeEdd({ judged: [true, false, false], changed: [true, true, false] });
  t.after(edd.stop);
  assert.strictEqual(await evaluate({ kit: s.kit, api: edd.api, project: 'project_default', stamp: s.file }, s.log), 0);
  const stamp = JSON.parse(s.read());
  assert.strictEqual(stamp.brief, forEval(), 'npm test passes again');
  assert.strictEqual(stamp.judged.passed, 2);
  assert.strictEqual(stamp.judged.before, 1);
  assert.deepStrictEqual(stamp.judged.totals, { total: 3, fixed: 1, regressed: 0, still_passing: 1, still_failing: 1 });
  assert.deepStrictEqual(stamp.judged.tests.map((x) => x.test + ' ' + x.outcome), ['A still_passing', 'B fixed', 'C still_failing']);
});

test('with no judged brief yet, the brief now runs alone and becomes the first', async (t) => {
  const s = setup(t, null);
  const edd = await fakeEdd({ changed: [false, true, true] });
  t.after(edd.stop);
  assert.strictEqual(await evaluate({ kit: s.kit, api: edd.api, project: 'project_default', stamp: s.file }, s.log), 0);
  assert.ok(!edd.calls.includes('POST /comparisons/suite'), 'nothing to compare with');
  const stamp = JSON.parse(s.read());
  assert.strictEqual(stamp.brief, forEval());
  assert.strictEqual(stamp.judged.passed, 2);
  assert.strictEqual(stamp.judged.comparison, undefined);
});

test('a missing kit file or an edd-platform that is down stops the eval and writes nothing', async (t) => {
  const s = setup(t, { brief: 'the old brief' });
  const before = s.read();
  fs.rmSync(path.join(s.kit, 'board_b.txt'));
  await assert.rejects(evaluate({ kit: s.kit, api: 'http://127.0.0.1:1/api', project: 'project_default', stamp: s.file }, s.log), /has no board_b\.txt/);
  fs.writeFileSync(path.join(s.kit, 'board_b.txt'), 'b');
  const edd = await fakeEdd({});
  edd.stop();
  await assert.rejects(evaluate({ kit: s.kit, api: edd.api, project: 'project_default', stamp: s.file }, s.log), /Could not reach .*Start edd-platform/);
  assert.strictEqual(s.read(), before);
});
