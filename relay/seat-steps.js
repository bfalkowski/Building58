// What a seat did and what it cost, read from Claude Code's own transcript of its session.
// Claude Code keeps each session's transcript in <its config folder>/projects/<the folder, each sign a dash>/<id>.jsonl.
// A seat's folder goes when its round ends, but that file stays, so the relay can read it later too.
// The relay reads the file when the room page asks, and keeps no copy and logs none of it.
//
// A step is one of: brief (the seat's first prompt), prompt (any later one), says (the seat's own words),
// runs (a tool it called) and result (what came back). Claude Code adds its own notes to a session's
// prompts and tool results in <system-reminder> blocks, with the person's own rules and account. Those are
// dropped, so a step holds only what the seat was told by the round and what it did.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const seatBoundary = require('./seat-boundary.js');

// Prices in dollars per million tokens, at Claude API list prices. A seat runs on the person's own plan,
// so this is what its tokens would cost on the API, not what the person is billed.
// From the claude-api skill bundled with Claude Code 2.1.319 (shared/models.md and shared/prompt-caching.md),
// read on 2026-11-13. Cache writes cost 1.25 times input for 5 minutes and 2 times input for 1 hour.
// A model not here is counted in tokens only, and its price is shown as unknown.
const PRICES = [
  { model: 'claude-fable-5-1', input: 10, output: 50, cacheRead: 0.25 },
  { model: 'claude-mythos-5-1', input: 10, output: 50, cacheRead: 0.25 },
  { model: 'claude-fable-5', input: 10, output: 50, cacheRead: 1 },
  { model: 'claude-mythos-5', input: 10, output: 50, cacheRead: 1 },
  { model: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.2 },
  { model: 'claude-opus-5', input: 5, output: 25, cacheRead: 0.5 },
  { model: 'claude-sonnet-5-5', input: 2, output: 10, cacheRead: 0.2 },
  // Haiku 5.5 costs more when one request's prompt is over 100K tokens. Its cache read price is not
  // listed, so it is taken as a tenth of input, as for most models.
  { model: 'claude-haiku-5-5', input: 0.1, output: 0.5, cacheRead: 0.01, over: { tokens: 100000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
];
// The longest name that starts the model's id, so claude-opus-5-5 is not taken for claude-opus-5.
function priceOf(model) {
  const id = String(model || '').toLowerCase();
  let best = null;
  for (const p of PRICES) if ((id === p.model || id.startsWith(p.model + '-') || id.startsWith(p.model + '[')) && (!best || p.model.length > best.model.length)) best = p;
  return best;
}
// The dollars of one request's usage, or null when the model has no price here.
function costOf(model, u) {
  const p = priceOf(model);
  if (!p) return null;
  const write5 = u.cache_creation ? Number(u.cache_creation.ephemeral_5m_input_tokens) || 0 : Number(u.cache_creation_input_tokens) || 0;
  const write1h = u.cache_creation ? Number(u.cache_creation.ephemeral_1h_input_tokens) || 0 : 0;
  const input = Number(u.input_tokens) || 0, read = Number(u.cache_read_input_tokens) || 0, out = Number(u.output_tokens) || 0;
  const r = p.over && input + read + write5 + write1h > p.over.tokens ? p.over : p;
  return (input * r.input + write5 * r.input * 1.25 + write1h * r.input * 2 + read * r.cacheRead + out * r.output) / 1e6;
}

const STEP = { brief: 4000, prompt: 2000, says: 4000, runs: 1000, result: 1500 };
const MAX_STEPS = 400, MAX_CHARS = 200000;
const REMINDER = /<system-reminder>[\s\S]*?(<\/system-reminder>|$)/g;
const PASTED = /<\/?pasted_content[^>]*>/g;
const clean = (s) => String(s || '').replace(REMINDER, '').replace(PASTED, '').trim();
const cut = (s, n) => (s.length > n ? s.slice(0, n) + ' … (' + (s.length - n) + ' more characters)' : s);

// Where a session's transcript is, for its folder, its session id and the Claude Code config folder it
// runs with (CLAUDE_CONFIG_DIR, or ~/.claude). This is the one place that knows, so a seat with a config
// folder of its own changes only what it passes here.
function fileOf(cwd, sessionId, configDir) {
  if (!cwd || !/^[0-9a-f-]{8,}$/i.test(String(sessionId || ''))) return null;
  return path.join(configDir || path.join(os.homedir(), '.claude'), 'projects', seatBoundary.projectFolder(cwd), sessionId + '.jsonl');
}

// Reads one transcript. steps: false counts only the tokens, for the spend, which reads often.
function read(file, opts) {
  const withSteps = !(opts && opts.steps === false);
  const out = { found: false, steps: [], truncated: false, worked: false, tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, usd: 0, unpriced: [] };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return out; }
  out.found = true;
  const usage = new Map();  // message id: [model, usage]. A message's blocks come on several lines, each with its usage.
  let chars = 0, briefed = false;
  const add = (kind, s, more) => {
    if (!withSteps) return;
    if (out.steps.length >= MAX_STEPS || chars >= MAX_CHARS) { out.truncated = true; return; }
    const t = cut(s, STEP[kind]);
    chars += t.length;
    out.steps.push(Object.assign({ kind, text: t }, more || {}));
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch (err) { continue; }
    const m = e && e.message;
    if (!m || (e.type !== 'user' && e.type !== 'assistant') || e.isMeta) continue;
    if (e.type === 'assistant') {
      out.worked = true;
      if (m.usage && m.model && m.model !== '<synthetic>') usage.set(m.id || e.uuid || usage.size, [m.model, m.usage]);
    }
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
    for (const p of parts) {
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'text') {
        const s = clean(p.text);
        if (!s) continue;
        if (e.type === 'assistant') add('says', s);
        else { add(briefed ? 'prompt' : 'brief', s); briefed = true; }
      } else if (p.type === 'tool_use') {
        const input = p.input || {};
        const s = typeof input.command === 'string' ? input.command : JSON.stringify(input);
        add('runs', s, { tool: String(p.name || 'tool') });
      } else if (p.type === 'tool_result') {
        const raw = typeof p.content === 'string' ? p.content : Array.isArray(p.content) ? p.content.map((c) => (c && c.type === 'text' ? c.text : '')).join('\n') : '';
        add('result', clean(raw) || '(nothing)', p.is_error ? { error: true } : undefined);
      }
    }
  }
  const unpriced = new Set();
  for (const [model, u] of usage.values()) {
    out.tokens.input += Number(u.input_tokens) || 0;
    out.tokens.cacheWrite += Number(u.cache_creation_input_tokens) || 0;
    out.tokens.cacheRead += Number(u.cache_read_input_tokens) || 0;
    out.tokens.output += Number(u.output_tokens) || 0;
    const c = costOf(model, u);
    if (c === null) unpriced.add(model); else out.usd += c;
  }
  out.unpriced = [...unpriced];
  out.models = [...new Set([...usage.values()].map(([model]) => model))];
  return out;
}

module.exports = { read, fileOf, costOf, priceOf, PRICES };
