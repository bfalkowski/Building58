// Checkouts: a session's own git worktree, so sessions added on one folder cannot change each other's
// files or the folder itself. Add worker gets one on a new branch, and an automatic PR review gets
// one at the PR's latest commit. Tasks have their own (relay/tasks.js). See docs/manual/running.html#checkouts.
//
// A checkout nobody can miss goes when its session ends. The rest wait in the panel for Clean up.
// Like the terminal, this answers only the room page on this machine, while RELAY_TERMINAL=1.
'use strict';
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const state = require('./state.js');
const terminal = require('./terminal.js');
const delivery = require('./delivery.js');
const tasks = require('./tasks.js');
const { git, excludeWorktrees, mainCheckout, WORKTREES } = tasks;
const history = require('./ticket-history.js');
const { claim } = require('./lockfile.js');

const FILE = state.file('checkouts.json', 'RELAY_CHECKOUTS_FILE');
const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;
const { MAX_PROMPT } = terminal;

// ---------- the store: { channel: [checkout] } ----------
// A relay that does not own the file does not read it: it cannot see the owner's sessions, so it
// could not tell that a checkout is in use.
const ownsFile = claim(FILE);
let store = {};
if (ownsFile) try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
  if (e.code !== 'ENOENT') {  // keep a file we cannot read, rather than writing over it
    const aside = FILE + '.unreadable-' + Date.now();
    try { fs.renameSync(FILE, aside); console.error('Could not read ' + FILE + '. Kept it as ' + aside); } catch (e2) { /* nothing to keep */ }
  }
}
function save() {
  if (!ownsFile) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('Could not save checkouts to ' + FILE + ': ' + e.message); }
}
const listOf = (channel) => store[channel] || (store[channel] = []);
function forget(channel, c) { store[channel] = listOf(channel).filter((x) => x !== c); save(); }

// ---------- taking one away ----------
const statusOf = (c) => tasks.statusOf(c.path);
// What the session left behind, files of any kind or commits, in words for the panel. Null for nothing.
async function leftBehind(c) {
  if (!fs.existsSync(c.path)) return null;
  const files = [], status = await statusOf(c);
  for (let i = 0; i < status.length; i++) { files.push(status[i].slice(3)); if (/^[RC]/.test(status[i])) i++; }  // a rename's old name comes next, with no status
  const moved = (await git(c.path, ['rev-parse', 'HEAD'])) !== c.commit;
  if (!files.length && !moved) return null;
  return 'It holds ' + [files.length ? 'files: ' + files.slice(0, 5).join(', ') + (files.length > 5 ? ' and ' + (files.length - 5) + ' more' : '') : '', moved ? 'new commits' : ''].filter(Boolean).join(', and ') + '.';
}
const refuseNested = (c) => tasks.refuseNested(c.repo, c.path);
// Git refuses if the checkout holds uncommitted work, and that refusal stands. Ignored files go with
// it, so clean asks first. Nothing committed is lost: a branch with new commits stays, and commits
// with no branch get one. Says which branches stayed.
async function remove(c) {
  if (!fs.existsSync(c.repo)) return [];
  await refuseNested(c);
  const kept = [];
  if (fs.existsSync(c.path)) {
    const head = await git(c.path, ['rev-parse', 'HEAD']);
    const onBranch = await git(c.path, ['symbolic-ref', '-q', 'HEAD']).catch(() => null);
    const saved = !onBranch && head !== c.commit ? 'kept-' + c.id : null;
    const own = onBranch && onBranch !== 'refs/heads/' + c.branch ? onBranch.replace(/^refs\/heads\//, '') : null;  // one the session made
    if (saved) await git(c.repo, ['branch', saved, head]);
    try { await git(c.repo, ['worktree', 'remove', c.path]); } catch (e) {
      if (saved) await git(c.repo, ['branch', '-D', saved]).catch(() => {});
      throw e;
    }
    if (saved) kept.push(saved);
    if (own) kept.push(own);
  } else await git(c.repo, ['worktree', 'prune']);
  if (c.ref) await git(c.repo, ['update-ref', '-d', c.ref]).catch(() => {});
  if (c.branch) {
    const tip = await git(c.repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + c.branch]).catch(() => null);
    // The checkout is gone by now. If git will not delete the branch, say so by listing it, not by failing.
    if (tip === c.commit) await git(c.repo, ['branch', '-D', c.branch]).catch(() => kept.push(c.branch));
    else if (tip) kept.push(c.branch);
  }
  return kept;
}
// Settle and Clean up both take a checkout away, and two at once make git refuse one (T-32). So each
// waits for the one before it on the same checkout.
const turns = new Map();
function inTurn(c, fn) {
  const run = (turns.get(c) || Promise.resolve()).then(fn);
  const done = run.catch(() => {}).then(() => { if (turns.get(c) === done) turns.delete(c); });
  turns.set(c, done);
  return run;
}
// A review is finished when its session ends. A worker with a conversation may come back with Resume,
// which needs the folder, so only a worker nobody ever spoke to goes by itself.
const settle = (channel, c, spoke, log) => inTurn(c, async () => {
  try {
    if (!listOf(channel).includes(c)) return;  // Clean up took it first
    if (c.kind === 'worker' && spoke) return;
    // One on the failed list (relay/terminal.js) is tried again in this folder, so it stays too.
    if (terminal.runningIn(c.path) || terminal.failedIn(c.path)) return;
    const left = await leftBehind(c);
    if (left) { c.left = left; save(); return; }
    await remove(c);
    forget(channel, c);
  } catch (e) { log('Could not clean up ' + c.path + ': ' + e.message); }
});
// A review or a PM from the last run that did not come back (relay/sessions.js) has nobody left in it. It runs
// after they are brought back, since one that did come back is still in use. The workers wait for
// Clean up, since whether anyone spoke to them went with the relay.
async function sweep() {
  if (!ownsFile) return;
  for (const channel of Object.keys(store)) {
    for (const c of listOf(channel).filter((x) => x.kind === 'reviewer' || x.kind === 'pm')) await settle(channel, c, false, console.error);
  }
}
// For a session brought back in a checkout: what to do when it ends, as when it first started.
function onExitFor(channel, cwd, log) {
  const c = cwd && listOf(channel).find((x) => cwd === x.path || cwd.startsWith(x.path + path.sep));
  return c ? (t) => settle(channel, c, t.spoke, log) : undefined;
}

// ---------- making one ----------
// Where a PR's commits come from. A remote whose path is the PR's repo is used by name. A clone of a
// fork, or a remote that still uses the repo's old name, has none, so the PR is fetched from the PR's
// repo itself, written the way one of the clone's GitHub remotes is written, so the same key or
// login works, and then over https. A session can open a PR elsewhere with gh pr create -R, and PR 7
// of another repo is not the one to review: a PR fetched that way must share history with the clone.
const SSH = process.env.RELAY_SSH_CMD || 'ssh';
const GITHUB_HOSTS = ['github.com', 'www.github.com', 'ssh.github.com'];
// A remote's address in parts: how it is reached (prefix), the host, and owner/name. Null for a local path.
function parseRemote(url) {
  let m = url.match(/^((?:https?|ssh|git|git\+ssh|ssh\+git):\/\/(?:[^/@]+@)?([^/:@]+)(?::\d+)?\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  if (m) return { prefix: m[1], host: m[2].toLowerCase(), repo: m[3], ssh: !/^(https?|git):/i.test(m[1]) };
  m = url.match(/^((?:[^/@:]+@)?([^/:@]+):)(?!\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/);  // git@host:owner/name, which is SSH
  if (m) return { prefix: m[1], host: m[2].toLowerCase(), repo: m[3], ssh: true };
  return null;
}
// An SSH host can be an alias in ~/.ssh/config, as in git@github-work:owner/name. ssh -G says what it
// stands for without connecting.
function sshHostname(host) {
  return new Promise((resolve) => {
    if (host.startsWith('-')) return resolve(null);
    execFile(SSH, ['-G', host], { timeout: 5000 }, (err, stdout) => {
      const m = !err && String(stdout).match(/^hostname\s+(\S+)/mi);
      resolve(m ? m[1].toLowerCase() : null);
    });
  });
}
async function onGitHub(r) {
  if (GITHUB_HOSTS.includes(r.host)) return true;
  return r.ssh && GITHUB_HOSTS.includes(await sshHostname(r.host));
}
// The clone's GitHub remotes, as written in its config and as git expands them with url.<base>.insteadOf.
async function githubRemotes(folder) {
  const lines = await git(folder, ['config', '--get-regexp', '^remote\\..*\\.url$']).catch(() => '');
  const found = [];
  for (const line of lines.split('\n')) {
    const m = line.match(/^remote\.(.+)\.url\s+(.+)$/);
    if (!m) continue;
    const expanded = await git(folder, ['ls-remote', '--get-url', m[1]]).catch(() => m[2]);
    for (const url of new Set([m[2], expanded])) {
      const r = parseRemote(url);
      if (r && await onGitHub(r)) found.push(Object.assign(r, { name: m[1] }));
    }
  }
  return found;
}
// { remote } to fetch by name, { urls } to try in turn, or null when the clone has no GitHub remote.
async function sourceFor(folder, owner, name) {
  const remotes = await githubRemotes(folder), want = (owner + '/' + name).toLowerCase();
  const own = remotes.find((r) => r.repo.toLowerCase() === want);
  if (own) return { remote: own.name };
  if (!remotes.length) return null;
  const urls = remotes.map((r) => r.prefix + owner + '/' + name + '.git').concat('https://github.com/' + owner + '/' + name + '.git');
  return { urls: [...new Set(urls)] };
}
// Git and ssh ask nothing on the relay's terminal: nobody is there to answer, and a prompt there would
// take the person's typing. ssh asks for a key's passphrase, or whether to trust a new host, on the
// terminal even with GIT_TERMINAL_PROMPT=0, so it is sent to an askpass that always says no. An
// SSH_ASKPASS of the person's own is used instead of the terminal, unless they said when to use it.
function quietEnv(env) {
  const own = env.SSH_ASKPASS ? { SSH_ASKPASS_REQUIRE: env.SSH_ASKPASS_REQUIRE || 'prefer' } : { SSH_ASKPASS: '/usr/bin/false', SSH_ASKPASS_REQUIRE: 'force' };
  return Object.assign({}, env, { GIT_TERMINAL_PROMPT: '0' }, own);
}
const NO_PROMPT = { timeout: 30000, env: quietEnv(process.env) };
// A remote's address can hold a token, as in https://x-access-token:TOKEN@github.com/o/r.git. The  // secret-check: allow
// fetch may use it, but what the relay says or logs leaves out everything before the @.
const unsecret = (text) => String(text).replace(/(\/\/)[^/@\s]+@/g, '$1');
const hasCommits = (top) => git(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).then(() => true, () => false);
// A PR's branch is usually checked out by its author, and git allows that only once, so a reviewer
// is on the branch's latest commit, with no branch of their own. refs/pull is on the PR's own repo, and
// also holds a PR whose branch is on a fork. A follow-up review names the commit the last review read
// in unlessAt. When the PR is still there, the push moved nothing, so nobody starts.
async function forReview(c, top, pr, unlessAt) {
  const [, owner, name, number] = pr.match(PR_URL);
  const source = await sourceFor(top, owner, name);
  if (!source) return [400, { ok: false, error: 'no_remote', message: top + ' has no remote at github.com, so it cannot review ' + pr + '.' }];
  c.ref = 'refs/office/review/' + c.id;
  const refspec = '+refs/pull/' + number + '/head:' + c.ref, fetch = ['fetch', '--no-write-fetch-head', '--no-tags'];
  if (source.remote) {
    try { await git(top, fetch.concat(source.remote, refspec), NO_PROMPT); } catch (e) {
      return [502, { ok: false, error: 'fetch', message: 'Could not fetch ' + pr + ': ' + unsecret(e.message) }];
    }
  } else {
    // With nothing to compare a PR to, it is refused before any fetch.
    if (!(await hasCommits(top))) return [400, { ok: false, error: 'no_commits', message: top + ' has no commits yet, so the relay cannot tell whether ' + pr + ' is of the same project. Review it from a clone of ' + owner + '/' + name + '.' }];
    const failed = [];
    for (const url of source.urls) {
      try { await git(top, fetch.concat(url, refspec), NO_PROMPT); failed.length = 0; break; } catch (e) { failed.push(unsecret(url + ': ' + e.message)); }
    }
    if (failed.length) return [502, { ok: false, error: 'fetch', message: 'No remote of ' + top + ' is ' + owner + '/' + name + ', and fetching ' + pr + ' from its own repo failed. ' + failed.join(' ') }];
  }
  c.commit = await git(top, ['rev-parse', c.ref]);
  if (source.urls && !(await git(top, ['merge-base', c.commit, 'HEAD']).then(() => true, () => false))) {
    await git(top, ['update-ref', '-d', c.ref]);
    return [400, { ok: false, error: 'unrelated', message: pr + ' shares no history with ' + top + ', so it is a PR of another project. Review it from a clone of ' + owner + '/' + name + '.' }];
  }
  if (unlessAt && c.commit === unlessAt) {
    await git(top, ['update-ref', '-d', c.ref]);
    return [200, { ok: true, unchanged: true, commit: c.commit }];
  }
  await git(c.repo, ['worktree', 'add', '--detach', c.path, c.commit]);
  return null;
}
async function forWorker(c, top) {
  c.commit = await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => null);
  if (!c.commit) return [409, { ok: false, error: 'no_commits', message: 'This repo has no commits yet, so it cannot have a second checkout. Tick Use this folder.' }];
  await git(c.repo, ['worktree', 'add', '-b', c.branch, c.path, c.commit]);
  return null;
}
// Told the commit and the reviewer's session of each review of a PR as it starts (relay/reviews.js).
let reviewSeen = null;
const onReview = (fn) => { reviewSeen = fn; };
// What a review of a PR asks for after its brief: a verdict, merge or fix (relay/autopilot.js, through
// relay/reviews.js). The automatic reviews add it themselves. The route adds it to Get a review.
let askOf = () => '';
const useAsk = (fn) => { askOf = fn; };
// How many are being made now. Update does not restart the relay in the middle of one (relay/update.js).
let making = 0;
async function create(channel, body, ctx) {
  making++;
  try { return await make(channel, body, ctx); } finally { making--; }
}
async function make(channel, body, ctx) {
  const from = terminal.expand(body.from), pr = body.pr ? String(body.pr) : null;
  const prompt = body.prompt ? String(body.prompt) + (pr ? require('./skills.js').brief('reviewer').trimEnd() : '') : '';  // a review's brief names the reviewer's skills
  const unlessAt = /^[0-9a-f]{40}$/.test(String(body.unlessAt || '')) ? String(body.unlessAt) : null;
  if (pr && !PR_URL.test(pr)) return [400, { ok: false, error: 'bad_pr', message: 'A PR link looks like https://github.com/owner/repo/pull/1.' }];
  if (prompt.length > MAX_PROMPT) return [400, { ok: false, error: 'bad_prompt', message: 'Keep the prompt to ' + MAX_PROMPT + ' characters.' }];
  const size = { cols: body.cols, rows: body.rows };
  const top = await git(from, ['rev-parse', '--show-toplevel']).catch(() => null);
  if (!top && pr) return [400, { ok: false, error: 'no_repo', message: 'Need a git repo to review a PR: ' + from }];
  if (!top) { const r = terminal.start(channel, Object.assign({ cwd: from }, size), ctx); return [r.status, r.body]; }  // nothing to check out, or a folder that is not there, which it names

  // Under the repo's own folder even when started from a linked worktree, since removing a worktree
  // takes along any worktree inside it. See tasks.js for why they live there.
  const repo = await mainCheckout(top), id = crypto.randomBytes(3).toString('hex'), kind = pr ? 'reviewer' : 'worker';
  const name = (pr ? 'review-' : 'worker-') + id;
  const c = { id, kind, repo, from, path: path.join(repo, WORKTREES, name), branch: pr ? null : name, ref: null, pr, commit: null, createdAt: new Date().toISOString() };
  try {
    await excludeWorktrees(repo);
    const refused = pr ? await forReview(c, top, pr, unlessAt) : await forWorker(c, top);
    if (refused) return refused;
  } catch (e) {
    if (c.ref) await git(repo, ['update-ref', '-d', c.ref]).catch(() => {});
    return [500, { ok: false, error: 'git', message: e.message }];
  }
  const prefix = pr ? '' : await git(from, ['rev-parse', '--show-prefix']);  // the same place in the new checkout, if it is tracked
  const cwd = prefix && fs.existsSync(path.join(c.path, prefix)) ? path.join(c.path, prefix) : c.path;
  // Where a new worker would start, seen from this session. Not a checkout that is about to go.
  const parent = listOf(channel).find((x) => x.path === top);
  const started = terminal.start(channel, Object.assign({ cwd, from: pr && parent ? parent.from : from, title: pr ? 'Review PR #' + pr.split('/').pop() : null, role: pr ? 'reviewer' : null, pr }, size), ctx,
    (t) => settle(channel, c, t.spoke, ctx.log), { reviewOf: pr });
  if (started.status >= 400) {  // nothing has happened in that checkout yet, so take it back
    await remove(c).catch((e) => ctx.log('Could not clean up ' + c.path + ': ' + e.message));
    return [started.status, started.body];
  }
  listOf(channel).push(c);
  save();
  if (pr && reviewSeen) reviewSeen(channel, pr, c.commit, started.body.id);
  if (pr) noteReviewer(channel, pr, started.body.id, body.auto ? 'automatic review' : 'you');
  // Typed by the relay, which waits for the trust question. A new folder can ask it where the author's did not.
  if (prompt) delivery.promptOnce(channel, started.body.id, prompt, (problem) => { if (problem) ctx.log('The review of ' + pr + ' did not get its prompt: ' + problem); });
  return [201, Object.assign({}, started.body, { checkout: view(channel, c) })];
}
// The PM reads the code a worker would start from: its base at the remote's latest commit, checked
// out with no branch, so a main folder that is behind does not hide new rules (T-40). It changes no
// code, so the checkout goes when its session ends. The main folder is left as it is. When there is
// no remote, or it cannot be reached, it reads the local branch, and the log says why. A branch
// with no commits cannot be checked out, so then it reads the folder itself.
const PM_NOTES = {
  no_remote: (c) => c.repo + ' has no remote for it.',
  unpushed: (c, r) => 'it is not on ' + r + '.',
  unreachable: (c, r) => r + ' could not be reached, so it may be behind.',
  has_local_commits: (c, r) => 'it has commits that ' + r + ' does not.'
};
async function forPm(channel, { top, base, title, cols, rows }, ctx) {
  making++;
  try {
    const own = { cwd: top, title, role: 'pm', cols, rows };
    const repo = await mainCheckout(top), id = crypto.randomBytes(3).toString('hex');
    const c = { id, kind: 'pm', repo, from: top, path: path.join(repo, WORKTREES, 'pm-' + id), branch: null, ref: null, pr: null, base, commit: null, createdAt: new Date().toISOString() };
    try {
      if (!(await tasks.hasBranch(repo, base))) throw new Error(base + ' has no commits yet');
      const checked = await tasks.checkRemote(repo, base);
      if (PM_NOTES[checked.state]) ctx.log('The PM reads ' + base + ' as it is here: ' + PM_NOTES[checked.state](c, checked.remote));
      c.commit = await git(repo, ['rev-parse', checked.start + '^{commit}']);
      await excludeWorktrees(repo);
      await git(repo, ['worktree', 'add', '--detach', c.path, c.commit]);
    } catch (e) {
      ctx.log('The PM reads ' + top + ' itself, with no checkout of its own: ' + unsecret(e.message));
      const r = terminal.start(channel, own, ctx);
      return [r.status, r.body];
    }
    const r = terminal.start(channel, Object.assign(own, { cwd: c.path, from: top }), ctx, (t) => settle(channel, c, t.spoke, ctx.log));
    if (r.status >= 400) {
      await remove(c).catch((e) => ctx.log('Could not clean up ' + c.path + ': ' + e.message));
      return [r.status, r.body];
    }
    listOf(channel).push(c);
    save();
    return [r.status, r.body];
  } finally { making--; }
}
// The branch the PM in this folder was asked from, which its tickets record as their base.
function pmBaseOf(channel, cwd) {
  const c = cwd && listOf(channel).find((x) => x.kind === 'pm' && (cwd === x.path || cwd.startsWith(x.path + path.sep)));
  return c ? c.base : null;
}
// A reviewer is linked to the task whose PR it reviews, in that ticket's history (relay/ticket-history.js),
// so the link stays after the reviewer ends and after the task's Clean up. A review that starts after
// Clean up finds its ticket in the saved history.
function noteReviewer(channel, pr, id, by) {
  const task = tasks.list(channel).find((x) => x.ticket && (x.pr === pr || x.history.some((h) => h.type === 'pr' && h.pr === pr)));
  const on = task ? { ticket: task.ticket, ticketAt: task.ticketAt, task: task.id } : history.ticketOfPr(channel, pr);
  const t = terminal.find(channel, id);
  if (on && t) history.add(channel, on, { stage: 'reviewer', role: 'reviewer', by, task: on.task, pr }, t);
}
const view = (channel, c) => Object.assign({}, c, { running: terminal.runningIn(c.path) });
// Ignored files go only with a yes that names them, so one that turned up since the question is asked about too.
// A review that just ended may be taken away by settle while this waits, and then there is nothing left to do.
const clean = (channel, c, body) => inTurn(c, async () => {
  if (!listOf(channel).includes(c)) return [200, { ok: true, removed: c.id, branches: [] }];
  if (terminal.runningIn(c.path)) return [409, { ok: false, error: 'in_use', message: 'A session is still running in this checkout. Stop it first.' }];
  let branches;
  try {
    if (fs.existsSync(c.repo) && fs.existsSync(c.path)) {
      const ignored = await tasks.unagreedIgnored(c.repo, c.path, body.ignored);
      if (ignored) return [409, { ok: false, error: 'ignored', ignored, message: 'This checkout holds files git ignores, and Clean up would delete them: ' + ignored.join(', ') }];
    }
    branches = await remove(c);
  } catch (e) { return [409, { ok: false, error: 'dirty', message: 'Git kept the checkout: ' + e.message }]; }
  forget(channel, c);
  return [200, { ok: true, removed: c.id, branches }];
});

// ---------- routes under /channels/{channel}/checkouts ----------
async function handle(req, res, channel, rest, ctx) {
  const route = rest.match(/^\/checkouts(?:\/([0-9a-f]{6})\/(clean))?$/);
  if (!route) { if (!/^\/checkouts(\/|$)/.test(rest)) return false; ctx.problem(res, 404, 'not_found', 'Unknown checkout route.'); return true; }
  const deny = terminal.localOnly(req, ctx.port);
  if (deny) { ctx.problem(res, 403, 'local_only', deny); return true; }
  if (!terminal.ENABLED) { ctx.problem(res, 404, 'terminal_off', 'Checkouts need the terminal. Start the relay with npm run office, or with RELAY_TERMINAL=1.'); return true; }
  const [, id] = route;
  let out;
  if (!id && req.method === 'GET') out = [200, { ok: true, checkouts: listOf(channel).map((c) => view(channel, c)) }];
  else if (!id && req.method === 'POST') {
    const body = await ctx.readJson(req);
    if (body.pr && body.prompt) body.prompt = String(body.prompt) + askOf(channel);  // Get a review asks for a verdict, like an automatic review
    out = await create(channel, body, ctx);
    if (body.pr && out[0] >= 400) ctx.log('No reviewer for ' + body.pr + ': ' + out[1].message);
    // Get a review pressed by the person: the COO counts it as a step-in (relay/coo.js).
    const task = body.pr && out[0] < 400 && !out[1].unchanged && tasks.list(channel).find((x) => x.pr === body.pr);
    if (task) { tasks.record(task, { type: 'review_asked', by: ctx.agent ? 'Lead' : 'you' }); tasks.save(); }
    if (out[1].unchanged) ctx.log('No follow-up review for ' + body.pr + ': it is still at ' + out[1].commit.slice(0, 7) + ', which the last review read.');
  }
  else if (id && req.method === 'POST') {
    const c = listOf(channel).find((x) => x.id === id);
    if (!c) { ctx.problem(res, 404, 'no_checkout', 'No such checkout on this channel.'); return true; }
    out = await clean(channel, c, await ctx.readJson(req));
  }
  if (!out) { ctx.problem(res, 404, 'not_found', 'Unknown checkout route.'); return true; }
  ctx.send(res, out[0], out[1]);
  return true;
}

module.exports = { forPm, pmBaseOf, parseRemote, unsecret, quietEnv, handle, create, sweep, onExitFor, onReview, useAsk, busy: () => making };
