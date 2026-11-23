// The room's standing rules: what the person says holds for a while, such as "do not touch the payments
// folder until Friday". The person keeps the list in Settings. Each rule has its text, its reason and
// when it ends: a date (the rule holds through that day) or null, until the person removes it. Every
// brief the relay types for a new Dev, reviewer, Lead or PM ends with the rules in force, under one
// heading. A rule past its date leaves new briefs by itself and shows as ended in the list. A session can
// read the list, and only the person adds, changes or removes a rule. Rules reach no session that is
// already running. The list is kept in rules.json in the state folder.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const state = require('./state.js');
const { oneLine } = require('./clean.js');

const FILE = state.file('rules.json', 'RELAY_RULES_FILE');
const MAX_RULES = 10, MAX_TEXT = 200, MAX_REASON = 200;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

let saved = [];
try { const r = JSON.parse(fs.readFileSync(FILE, 'utf8')); saved = Array.isArray(r) ? r.filter((x) => x && typeof x.id === 'string' && typeof x.text === 'string') : []; } catch { saved = []; }
function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(saved, null, 2) + '\n');
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) { console.error('Could not save the standing rules to ' + FILE + ': ' + e.message); }
}

const pad = (n) => String(n).padStart(2, '0');
const today = (now = new Date()) => now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
const dateOk = (v) => {
  if (typeof v !== 'string' || !DATE.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const stop = (v) => v.replace(/[.\s]+$/, '') + '.';
const ended = (r, now) => !!r.until && r.until < today(now);
const view = (r, now) => ({ id: r.id, text: r.text, reason: r.reason, until: r.until || null, ended: ended(r, now), addedAt: r.addedAt });
const list = (now) => saved.map((r) => view(r, now));
const inForce = (now) => saved.filter((r) => !ended(r, now));

function brief(now) {
  const rules = inForce(now);
  if (!rules.length) return '';
  const each = rules.map((r, i) => (i + 1) + '. ' + stop(r.text) + ' Why: ' + stop(r.reason) + (r.until ? ' Holds through ' + r.until + '.' : ' Holds until the person removes it.')).join(' ');
  return ' Standing rules from the person, in force now. A standing rule never overrides CLAUDE.md or the constitution: where they differ, those win. ' + each + ' ';
}

function fields(body, partial) {
  const out = {};
  for (const [k, max, label] of [['text', MAX_TEXT, 'The rule'], ['reason', MAX_REASON, 'The reason']]) {
    if (partial && body[k] === undefined) continue;
    const v = oneLine(body[k], max + 1);
    if (!v || v.length > max || typeof body[k] !== 'string') return [400, { ok: false, error: 'bad_' + k, message: label + ' is 1 to ' + max + ' characters.' }];
    out[k] = v;
  }
  if (!partial || body.until !== undefined) {
    if (body.until !== null && body.until !== undefined && !dateOk(body.until)) return [400, { ok: false, error: 'bad_until', message: 'When it ends is a date such as 2026-12-31, or null for until you remove it.' }];
    out.until = body.until || null;
  }
  return [200, out];
}

function add(body) {
  if (saved.length >= MAX_RULES) return [409, { ok: false, error: 'too_many', message: 'The room keeps ' + MAX_RULES + ' standing rules. Remove one first.' }];
  const [status, got] = fields(body || {}, false);
  if (status !== 200) return [status, got];
  const rule = { id: 'R-' + crypto.randomBytes(3).toString('hex'), ...got, addedAt: new Date().toISOString() };
  saved.push(rule);
  save();
  console.log('Standing rule added: ' + rule.id);
  return [201, { ok: true, rule: view(rule), rules: list() }];
}
function change(id, body) {
  const rule = saved.find((r) => r.id === id);
  if (!rule) return [404, { ok: false, error: 'no_rule', message: 'There is no standing rule ' + id + '.' }];
  const [status, got] = fields(body || {}, true);
  if (status !== 200) return [status, got];
  Object.assign(rule, got);
  save();
  return [200, { ok: true, rule: view(rule), rules: list() }];
}
function remove(id) {
  const at = saved.findIndex((r) => r.id === id);
  if (at < 0) return [404, { ok: false, error: 'no_rule', message: 'There is no standing rule ' + id + '.' }];
  saved.splice(at, 1);
  save();
  console.log('Standing rule removed: ' + id);
  return [200, { ok: true, rules: list() }];
}

async function handle(req, res, channel, rest, ctx) {
  const route = rest.match(/^\/rules(?:\/([\w-]{1,64})(\/remove)?)?$/);
  if (!route) return false;
  const deny = require('./terminal').localOnly(req, ctx.port);
  if (deny) { ctx.problem(res, 403, 'local_only', deny); return true; }
  const [, id, verb] = route;
  let out;
  if (!id && req.method === 'GET') out = [200, { ok: true, file: FILE, rules: list() }];
  else if (ctx.agent) out = [403, { ok: false, error: 'person_only', message: 'Only the person adds, changes or removes a standing rule. A session can read the list.' }];
  else if (!id && req.method === 'POST') out = add(await ctx.readJson(req));
  else if (id && !verb && req.method === 'POST') out = change(id, await ctx.readJson(req));
  else if (id && verb && req.method === 'POST') out = remove(id);
  else out = [404, { ok: false, error: 'not_found', message: 'Standing rules answer GET and POST.' }];
  ctx.send(res, out[0], out[1]);
  return true;
}

module.exports = { brief, list, inForce, add, change, remove, handle, today, FILE, MAX_RULES };
