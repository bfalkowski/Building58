#!/usr/bin/env node
// Stands in for `gh api` with the few GitHub issue routes relay/ticket-stores/github.js calls, so its
// tests need no network. FAKE_GITHUB_DIR holds state.json (the repos' issues and labels) and calls.log.
// Write { "fail": "message" } to fail.json to make every call fail, and add "match": "text" to fail
// only the calls whose arguments hold that text.
'use strict';
const fs = require('fs');
const path = require('path');

const dir = process.env.FAKE_GITHUB_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), args.join(' ') + '\n');
const stop = (status, message) => { console.log(JSON.stringify({ message })); console.error('gh: ' + message + ' (HTTP ' + status + ')'); process.exit(1); };
let failing = null;
try { failing = JSON.parse(fs.readFileSync(path.join(dir, 'fail.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (failing && (!failing.match || args.join(' ').includes(failing.match))) stop(500, failing.fail);

const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const method = flag('--method') || 'GET';
const route = args.find((a, i) => i > 0 && a.startsWith('/'));
const input = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8') || '{}') : {};
const [where, query] = route.split('?');

// One call at a time, since the relay can run several.
const lock = path.join(dir, 'lock');
for (let i = 0; ; i++) {
  try { fs.mkdirSync(lock); break; } catch (e) { if (i > 500) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
}
const file = path.join(dir, 'state.json');
let state = {};
try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first call */ }
let out, status = 200;
try { out = handle(); } finally {
  fs.writeFileSync(file, JSON.stringify(state));
  fs.rmdirSync(lock);
}
if (status >= 400) stop(status, out);
console.log(JSON.stringify(args.includes('--slurp') ? [out] : out));

function handle() {
  const m = /^\/repos\/([\w.-]+\/[\w.-]+)\/(labels|issues)(?:\/(\d+))?(?:\/dependencies\/blocked_by(?:\/(\d+))?)?$/.exec(where);
  if (!m) { status = 404; return 'Not Found'; }
  const [, name, kind, num, blockerId] = m;
  const repo = state[name] || (state[name] = { next: 1, issues: [], labels: [] });
  const now = () => new Date(Date.now() + (state.tick = (state.tick || 0) + 1) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');  // each change a second later, as on GitHub
  const view = (i) => ({ ...i, labels: i.labels.map((n) => ({ name: n })), repository_url: 'https://api.github.com/repos/' + name, issue_dependencies_summary: { blocked_by: i.blockedBy.length, total_blocked_by: i.blockedBy.length, blocking: 0, total_blocking: 0 }, blockedBy: undefined });
  if (kind === 'labels') {
    if (repo.labels.includes(input.name)) { status = 422; return 'Validation Failed'; }
    repo.labels.push(input.name); status = 201; return { name: input.name };
  }
  const label = (names) => { for (const n of names || []) if (!repo.labels.includes(n)) repo.labels.push(n); return names || []; };
  if (!num) {
    if (method === 'POST') {
      const at = now();
      const issue = { number: repo.next, id: 9000 + repo.next, title: input.title, body: input.body || null, state: 'open', state_reason: null, labels: label(input.labels), blockedBy: [], created_at: at, updated_at: at };
      repo.next++; repo.issues.push(issue); status = 201; return view(issue);
    }
    const all = new URLSearchParams(query).get('state') === 'all';
    return repo.issues.filter((i) => all || i.state === 'open').map(view);
  }
  const issue = repo.issues.find((i) => i.number === Number(num));
  if (!issue) { status = 404; return 'Not Found'; }
  if (where.includes('/dependencies/')) {
    if (method === 'GET') return issue.blockedBy.map((id) => view(repo.issues.find((i) => i.id === id)));
    if (method === 'POST') {
      const b = repo.issues.find((i) => i.id === input.issue_id);
      if (!b) { status = 404; return 'Not Found'; }
      if (!issue.blockedBy.includes(b.id)) issue.blockedBy.push(b.id);
      issue.updated_at = now(); status = 201; return view(issue);
    }
    issue.blockedBy = issue.blockedBy.filter((id) => id !== Number(blockerId));
    issue.updated_at = now(); return view(issue);
  }
  if (method === 'PATCH') {
    for (const k of ['title', 'body', 'state']) if (input[k] !== undefined) issue[k] = input[k];
    if (input.labels) issue.labels = label(input.labels);
    if (input.state) issue.state_reason = input.state === 'closed' ? input.state_reason || 'completed' : issue.state_reason ? 'reopened' : null;
    issue.updated_at = now();
  }
  return view(issue);
}
