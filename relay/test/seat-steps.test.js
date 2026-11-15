// relay/seat-steps.js: a seat's steps and spend, read from a Claude Code transcript.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const seatSteps = require('../seat-steps.js');
const { writeTranscript, REQUEST_USD } = require('./transcript.fixture.js');

function home(t) {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seat-steps-')));
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  return h;
}
const ID = '3d8cf4d9-6a61-47bc-b672-74f78023adfd';

test('the transcript is found under the config folder, ~/.claude unless the seat has its own', () => {
  assert.strictEqual(seatSteps.fileOf('/a/b.c/S1', ID, '/cfg'), '/cfg/projects/-a-b-c-S1/' + ID + '.jsonl');
  assert.strictEqual(seatSteps.fileOf('/a/S1', ID), path.join(os.homedir(), '.claude', 'projects', '-a-S1', ID + '.jsonl'));
  assert.strictEqual(seatSteps.fileOf('/a/S1', '../x'), null, 'a session id is an id, not a path');
});

test('a model gets its own price, not that of a shorter name it starts with', () => {
  assert.strictEqual(seatSteps.priceOf('claude-opus-5-5').model, 'claude-opus-5-5');
  assert.strictEqual(seatSteps.priceOf('claude-opus-5').model, 'claude-opus-5');
  assert.strictEqual(seatSteps.priceOf('claude-opus-5-5[1m]').model, 'claude-opus-5-5');
  assert.strictEqual(seatSteps.priceOf('claude-opus-50'), null);
  assert.strictEqual(seatSteps.priceOf('<synthetic>'), null);
});

test('the cost of a request: input, cache writes for 5 minutes and 1 hour, cache reads and output', () => {
  // Sonnet 5.5 at 2 and 10 dollars a million: 1000*2 + 100*2.5 + 200*4 + 10000*0.2 + 300*10 = 8050.
  const u = { input_tokens: 1000, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 }, cache_read_input_tokens: 10000, output_tokens: 300 };
  assert.ok(Math.abs(seatSteps.costOf('claude-sonnet-5-5', u) - 8050 / 1e6) < 1e-12);
  // With no split of the cache writes, they count as 5 minute ones.
  assert.ok(Math.abs(seatSteps.costOf('claude-sonnet-5-5', { input_tokens: 0, cache_creation_input_tokens: 400 }) - 400 * 2.5 / 1e6) < 1e-12);
  // Haiku 5.5 costs more when one request's prompt is over 100K tokens.
  assert.ok(Math.abs(seatSteps.costOf('claude-haiku-5-5', { input_tokens: 1000, output_tokens: 1000 }) - (1000 * 0.1 + 1000 * 0.5) / 1e6) < 1e-12);
  assert.ok(Math.abs(seatSteps.costOf('claude-haiku-5-5', { input_tokens: 1000, cache_read_input_tokens: 100000, output_tokens: 1000 }) - (1000 * 0.5 + 100000 * 0.05 + 1000 * 2.5) / 1e6) < 1e-12);
  assert.strictEqual(seatSteps.costOf('claude-future-9', { input_tokens: 5 }), null);
});

test('the steps are the brief, what the seat said, ran and got back, and nothing Claude Code added', (t) => {
  const h = home(t);
  const file = writeTranscript(h, '/x/S1', ID, { brief: 'Read the papers.', requests: 2 });
  const r = seatSteps.read(file);
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.worked, true);
  assert.deepStrictEqual(r.steps.map((s) => s.kind), ['brief', 'says', 'runs', 'result', 'says', 'runs', 'result', 'says']);
  assert.strictEqual(r.steps[0].text, 'Read the papers.');
  assert.ok(!/REMINDER-MARK|META-MARK|THINK-MARK|example\.com|pasted_content/.test(JSON.stringify(r.steps)));
  assert.ok(Math.abs(r.usd - 2 * REQUEST_USD) < 1e-12, 'the synthetic message and the repeated lines cost nothing more');
  assert.deepStrictEqual(r.models, ['claude-opus-5-5']);
  const cheap = seatSteps.read(file, { steps: false });
  assert.deepStrictEqual(cheap.steps, []);
  assert.strictEqual(cheap.usd, r.usd);
});

test('a long transcript is cut: each step, and the whole', (t) => {
  const h = home(t);
  const file = writeTranscript(h, '/x/S1', ID, { brief: 'B'.repeat(9000), requests: 300 });
  const r = seatSteps.read(file);
  assert.match(r.steps[0].text, /^B{4000} … \(5000 more characters\)$/);
  assert.strictEqual(r.steps.length, 400);
  assert.strictEqual(r.truncated, true);
  assert.ok(Math.abs(r.usd - 300 * REQUEST_USD) < 1e-9, 'the spend counts the whole transcript');
});

test('a missing or broken transcript reads as not found, or skips its bad lines', (t) => {
  const h = home(t);
  assert.strictEqual(seatSteps.read(path.join(h, 'nope.jsonl')).found, false);
  const file = path.join(h, 'bad.jsonl');
  fs.writeFileSync(file, 'not json\n{"type":"user","message":{"role":"user","content":"Hi"}}\n');
  const r = seatSteps.read(file);
  assert.deepStrictEqual(r.steps, [{ kind: 'brief', text: 'Hi' }]);
  assert.strictEqual(r.worked, false);
});
