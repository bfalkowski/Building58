// The one GitHub pass (467). One GraphQL call for each repo that has an open task PR reads every open PR in it:
// state, head, mergeable state, checks. The answer goes into relay/gh.js's cache, so Autopilot, the pipeline,
// the PR watch, chat and the comment loop that ask gh.pr() for a PR get it from here, with no call of their
// own, for as long as the cache holds it. A call that asks for a fresh read, such as the one before a merge, still goes to GitHub.
// It runs on a timer (githubPassSeconds) and at once when a task changes state. See docs/manual/how-it-works.html#github-polling.
'use strict';
const tasks = require('./tasks.js');
const config = require('./config.js');
const gh = require('./gh.js');

const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;
const PAGE = 100;
const MAX_PAGES = 5;
const QUERY = 'query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:' + PAGE + ',after:$after){pageInfo{hasNextPage endCursor}nodes{url state headRefOid mergeable mergeStateStatus updatedAt mergedAt commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){pageInfo{hasNextPage}nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}}}}}';

const last = new Map();
const seenIn = new Map();
let running = null, ranAt = 0;

const truncated = (node) => {
  const commit = (((node.commits || {}).nodes || [])[0] || {}).commit;
  const c = commit && commit.statusCheckRollup && commit.statusCheckRollup.contexts;
  return !!(c && c.pageInfo && c.pageInfo.hasNextPage);
};
function valueOf(node) {
  const commit = (((node.commits || {}).nodes || [])[0] || {}).commit;
  const rollup = commit && commit.statusCheckRollup;
  const checks = rollup && rollup.contexts && Array.isArray(rollup.contexts.nodes) ? rollup.contexts.nodes.filter(Boolean) : [];
  return { state: node.state, headRefOid: node.headRefOid, mergeable: node.mergeable, mergeStateStatus: node.mergeStateStatus, statusCheckRollup: checks, mergedAt: node.mergedAt };
}

function reposWanted() {
  const out = new Map();
  for (const channel of tasks.channels()) {
    for (const t of tasks.list(channel)) {
      const m = t.state !== 'done' && PR_URL.exec(t.pr || '');
      if (m && !out.has(m[1] + '/' + m[2])) out.set(m[1] + '/' + m[2], t.repo);
    }
  }
  return out;
}

async function readRepo(slug, cwd) {
  const [owner, name] = slug.split('/'), nodes = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const args = ['api', 'graphql', '-f', 'query=' + QUERY, '-f', 'owner=' + owner, '-f', 'name=' + name].concat(after ? ['-f', 'after=' + after] : []);
    const out = await gh.run(args, { cwd, timeout: 30000 });
    const prs = (((JSON.parse(out).data || {}).repository || {}).pullRequests) || {};
    nodes.push(...(prs.nodes || []));
    if (!(prs.pageInfo && prs.pageInfo.hasNextPage)) break;
    after = prs.pageInfo.endCursor;
  }
  return nodes;
}

async function once(repos) {
  if (gh.paused()) return { calls: 0, prs: 0 };
  const ttl = Math.max(3 * 60 * 1000, 3 * config.get('githubPassSeconds') * 1000);
  const before = gh.made();
  let prs = 0;
  for (const [slug, cwd] of repos || reposWanted()) {
    let nodes;
    try { nodes = await readRepo(slug, cwd); } catch (e) { console.error('GitHub pass: could not read ' + slug + ': ' + e.message); continue; }
    const now = new Set(nodes.filter((n) => n && n.url).map((n) => n.url));
    for (const url of seenIn.get(slug) || []) if (!now.has(url)) { gh.forget(url); last.delete(url); }
    seenIn.set(slug, now);
    for (const node of nodes) {
      if (!node || !node.url) continue;
      if (truncated(node)) { gh.forget(node.url); last.delete(node.url); continue; }
      const key = node.updatedAt + ' ' + node.headRefOid, have = last.get(node.url);
      const value = have && have.key === key ? have.value : valueOf(node);
      last.set(node.url, { key, value });
      gh.seed(node.url, value, ttl);
      prs++;
    }
  }
  ranAt = Date.now();
  return { calls: gh.made() - before, prs };
}
function pass() {
  if (!running) running = once().finally(() => { running = null; });
  return running;
}

function begin() {
  config.every('githubPassSeconds', () => { pass().catch((e) => console.error('GitHub pass: ' + e.message)); }, 2000);
  tasks.events.on('state', () => { if (Date.now() - ranAt > 5000) pass().catch(() => {}); });
}

module.exports = { begin, pass, once, truncated, valueOf, reposWanted, QUERY };
