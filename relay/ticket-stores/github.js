// A ticket store on GitHub issues, through `gh api`, so it uses your gh login and needs no new key.
// It is off unless the relay starts with RELAY_TICKET_STORE=relay/ticket-stores/github.js.
//
// RELAY_TICKET_REPO says which repo keeps a channel's tickets:
//   RELAY_TICKET_REPO=owner/repo                       the room channel
//   RELAY_TICKET_REPO=office=owner/repo,demo=owner/b   one repo for each channel named; others have none
// A channel with no repo has no tickets and cannot file one. Two channels cannot name one repo: tasks
// belong to a channel, so the other channel would see a started ticket with no task and offer Start again.
//
// How a ticket is kept:
//   id         the issue number, as text
//   title      the issue's title
//   body       the issue's body, with a hidden note at the end for what GitHub has no place for
//              (repo, base, createdBy and anything else the relay gives it). The relay signs the note
//              and the issue number with a key kept on this computer (RELAY_TICKET_KEY_FILE,
//              github-store.key in the state folder), and reads a note only when the signature holds.
//              Otherwise the ticket's repo is RELAY_TICKET_FOLDER (by default the folder that holds
//              this code), it has no base, so it starts from that folder's branch, and createdBy is the
//              issue's author on GitHub. A note that does not check is kept as it is on every write.
//   status     triage, ready and started are the labels office:triage, office:ready, office:started.
//              done is closed as completed, and rejected is closed as not planned.
//   priority   the label office:priority-high, -normal or -low
//   blockedBy  GitHub's issue dependencies. A blocker that is not an issue in the repo stays in the note.
// The labels are made the first time they are needed. An issue is a ticket only if it has an office:
// label, so someone who can label the repo's issues can file one on GitHub by adding office:triage.
//
// list() is cached for RELAY_TICKET_CACHE_MS (10 seconds by default). After that the Board gets the
// cached list at once while a new one is fetched, so a change made on GitHub shows a poll later.
// What the relay writes through this store shows at once.
'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const state = require('../state.js');

const STATUS_LABELS = { triage: 'office:triage', ready: 'office:ready', started: 'office:started' };
const PRIORITIES = ['high', 'normal', 'low'];
const COLORS = { 'office:triage': 'fbca04', 'office:ready': '0e8a16', 'office:started': '1d76db', 'office:priority-high': 'd93f0b', 'office:priority-normal': 'c5def5', 'office:priority-low': 'ededed' };
const MAX_TITLE = 80, MAX_BODY = 8000;  // the limits relay/tickets.js sets at filing, for text edited on GitHub
const NATIVE = ['id', 'title', 'body', 'status', 'priority', 'blockedBy', 'createdAt', 'updatedAt'];
const NOTE = /\n*<!-- office (\{(?:(?!-->).)*\}) -->\s*$/s;  // the last note: one never holds -->, since > is written \u003e
// eslint-disable-next-line no-control-regex -- the same characters relay/tickets.js takes out, since text edited on GitHub skips its checks
const clean = (v) => String(v == null ? '' : v).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const isNumber = (id) => /^[1-9]\d{0,9}$/.test(String(id));

function repos(spec) {
  const out = new Map();
  for (const part of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [channel, repo] = part.includes('=') ? part.split('=').map((s) => s.trim()) : ['office', part];
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split('/').some((x) => /^\.+$/.test(x))) throw new Error('RELAY_TICKET_REPO: ' + repo + ' is not owner/repo');
    const twin = [...out].find(([c, r]) => c !== channel && r.toLowerCase() === repo.toLowerCase());
    if (twin) throw new Error('RELAY_TICKET_REPO: channels ' + twin[0] + ' and ' + channel + ' both name ' + repo + '. Give each channel its own repo.');
    out.set(channel, repo);
  }
  return out;
}

function open(options) {
  const o = options || {};
  const GH = o.gh || process.env.GH_CMD || 'gh';
  const map = repos(o.repo !== undefined ? o.repo : process.env.RELAY_TICKET_REPO);
  const ttl = Number(o.cacheMs !== undefined ? o.cacheMs : process.env.RELAY_TICKET_CACHE_MS || 10000);
  const TTL = Number.isFinite(ttl) && ttl >= 0 ? ttl : 10000;
  const repoOf = (project) => map.get(project) || null;
  const FOLDER = o.folder || process.env.RELAY_TICKET_FOLDER || path.resolve(__dirname, '..', '..');
  const KEY_FILE = o.keyFile || state.file('github-store.key', 'RELAY_TICKET_KEY_FILE');
  let key = null;
  function keyNow() {
    if (key) return key;
    try { key = fs.readFileSync(KEY_FILE); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
      try { fs.writeFileSync(KEY_FILE, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' }); } catch (e2) { if (e2.code !== 'EEXIST') throw e2; }
      key = fs.readFileSync(KEY_FILE);
    }
    return key;
  }
  // The signature covers the issue number too, so a note copied onto another issue does not check.
  const signOf = (note, number) => crypto.createHmac('sha256', keyNow()).update(number + '\n' + JSON.stringify(note)).digest('hex').slice(0, 32);
  const signed = (note, number) => Object.assign({}, note, { sig: signOf(note, number) });
  // The note's fields, only if the relay wrote them. Someone who edits the issue can change the note too.
  function trusted(note, number) {
    if (!note || typeof note !== 'object' || Array.isArray(note) || typeof note.sig !== 'string' || !/^[0-9a-f]{32}$/.test(note.sig)) return null;
    const { sig, ...rest } = note;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(signOf(rest, number))) ? rest : null;
  }

  // gh api prints the body, and on a failed call says "(HTTP 404)" on stderr.
  function api(method, route, input, paginate) {
    return new Promise((resolve, reject) => {
      const args = ['api', '--method', method, route, ...(input ? ['--input', '-'] : []), ...(paginate ? ['--paginate', '--slurp'] : [])];
      const child = spawn(GH, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => { clearTimeout(timer); reject(new Error('Could not run ' + GH + ': ' + e.message)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const m = /HTTP (\d{3})/.exec(err);
          const e = new Error('gh api ' + method + ' ' + route + ': ' + (err.trim() || 'exit ' + code));
          e.status = m ? Number(m[1]) : 0;
          return reject(e);
        }
        try { resolve(out.trim() ? JSON.parse(out) : null); } catch (e) { reject(new Error('gh api ' + route + ' did not print JSON')); }
      });
      child.stdin.end(input ? JSON.stringify(input) : '');
    });
  }
  const gone = (e) => e.status === 404 || e.status === 410;

  const made = new Set();
  async function ensureLabels(repo, names) {
    for (const name of names) {
      if (made.has(repo + ' ' + name)) continue;
      try { await api('POST', '/repos/' + repo + '/labels', { name, color: COLORS[name] || 'ededed', description: 'Kept by the room relay' }); } catch (e) { if (e.status !== 422) throw e; }  // 422: it is there already
      made.add(repo + ' ' + name);
    }
  }

  const noteOf = (body) => { const m = NOTE.exec(body || ''); if (!m) return null; try { return JSON.parse(m[1]); } catch (e) { return null; } };
  const withNote = (text, note, number) => (text ? text + '\n\n' : '') + '<!-- office ' + JSON.stringify(signed(note, number)).replace(/>/g, '\\u003e') + ' -->';
  const labelNames = (issue) => (issue.labels || []).map((l) => String(l.name || l));
  const lower = (issue) => labelNames(issue).map((l) => l.toLowerCase());  // GitHub ignores case in label names
  const isTicket = (issue) => !issue.pull_request && lower(issue).some((l) => l.startsWith('office:'));
  // A note this relay's key did not sign: forged, edited, or signed by a relay with another key.
  const foreignNote = (issue) => { const m = NOTE.exec(issue.body || ''); return m && !trusted(noteOf(issue.body), issue.number) ? m[0].replace(/^\n+/, '') : null; };
  const sameRepo = (issue, repo) => !issue.repository_url || issue.repository_url.toLowerCase().endsWith('/repos/' + repo.toLowerCase());

  function ticketOf(issue, blockers) {
    let mine = null;
    try { mine = trusted(noteOf(issue.body), issue.number); } catch (e) { /* a note that cannot be checked is not read */ }
    const note = mine || { repo: FOLDER, createdBy: issue.user && issue.user.login ? clean(issue.user.login).slice(0, 39) + ' on GitHub' : 'GitHub' };
    const labels = lower(issue);
    const status = issue.state === 'closed'
      ? (issue.state_reason === 'not_planned' || issue.state_reason === 'duplicate' ? 'rejected' : 'done')
      : (Object.keys(STATUS_LABELS).find((s) => labels.includes(STATUS_LABELS[s])) || 'triage');
    const priority = PRIORITIES.find((p) => labels.includes('office:priority-' + p)) || 'normal';
    const { blockedBy: extra, ...rest } = note;
    return Object.assign({}, rest, {
      id: String(issue.number),
      title: clean(issue.title).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE),
      body: clean(String(issue.body || '').replace(NOTE, '')).trim().slice(0, MAX_BODY),
      status, priority,
      blockedBy: [...new Set([...blockers.map(String), ...(Array.isArray(extra) ? extra.map(String) : [])])],
      createdAt: issue.created_at,
      updatedAt: issue.updated_at
    });
  }
  const dbIds = new Map();  // "repo #n" to the issue's id, which the dependency calls want
  async function blockersOf(repo, issue) {
    const s = issue.issue_dependencies_summary;
    if (s && !s.total_blocked_by && !s.blocked_by) return [];
    let list;
    try { list = await api('GET', '/repos/' + repo + '/issues/' + issue.number + '/dependencies/blocked_by?per_page=100'); } catch (e) {
      if (gone(e)) return [];  // a repo or plan without issue dependencies
      throw e;
    }
    const here = (list || []).filter((b) => sameRepo(b, repo));  // a blocker in another repo has no id here
    for (const b of here) dbIds.set(repo + ' #' + b.number, b.id);
    return here.map((b) => b.number);
  }
  async function dbId(repo, n) {
    const key = repo + ' #' + n;
    if (!dbIds.has(key)) { try { dbIds.set(key, (await api('GET', '/repos/' + repo + '/issues/' + n)).id); } catch (e) { if (gone(e)) return null; throw e; } }
    return dbIds.get(key);
  }
  async function fetchOne(repo, n) {
    let issue;
    try { issue = await api('GET', '/repos/' + repo + '/issues/' + n); } catch (e) { if (gone(e)) return null; throw e; }
    if (!issue || !isTicket(issue)) return null;
    dbIds.set(repo + ' #' + issue.number, issue.id);
    return ticketOf(issue, await blockersOf(repo, issue));
  }

  // Each project's cache: the tickets by id, when the list was last fetched, and when each was last written.
  const caches = new Map();
  const cacheOf = (project) => { if (!caches.has(project)) caches.set(project, { tickets: new Map(), listedAt: 0, writes: 0, wrote: new Map(), wroteAt: new Map(), refreshing: null }); return caches.get(project); };
  const copy = (t) => (t ? JSON.parse(JSON.stringify(t)) : null);
  const keep = (project, t) => { const c = cacheOf(project); c.tickets.set(t.id, t); c.wrote.set(t.id, ++c.writes); c.wroteAt.set(t.id, Date.now()); return copy(t); };
  const sorted = (c) => [...c.tickets.values()].sort((a, b) => Number(a.id) - Number(b.id)).map(copy);

  function refresh(project, repo) {
    const c = cacheOf(project);
    if (c.refreshing) return c.refreshing;
    const began = Date.now(), seen = c.writes;
    c.refreshing = (async () => {
      const pages = await api('GET', '/repos/' + repo + '/issues?state=all&sort=created&direction=asc&per_page=100', null, true);
      const issues = (pages || []).flat().filter(isTicket);
      const fresh = new Map();
      for (const issue of issues) {
        dbIds.set(repo + ' #' + issue.number, issue.id);
        fresh.set(String(issue.number), ticketOf(issue, await blockersOf(repo, issue)));
      }
      for (const [id, n] of c.wrote) if (n > seen && c.tickets.has(id)) fresh.set(id, c.tickets.get(id));  // written while this list was on its way
      c.tickets = fresh; c.listedAt = began;
    })().finally(() => { c.refreshing = null; });
    return c.refreshing;
  }

  // Sets the dependencies to the issue numbers in `want`, and returns the ids GitHub could not take.
  async function setBlockers(repo, n, now, want) {
    const nums = want.filter((id) => isNumber(id) && Number(id) !== Number(n));
    const stay = [];
    for (const id of nums) {
      if (now.includes(Number(id))) continue;
      const blocker = await dbId(repo, id);
      if (!blocker) { stay.push(id); continue; }
      await api('POST', '/repos/' + repo + '/issues/' + n + '/dependencies/blocked_by', { issue_id: blocker });
    }
    for (const id of now) {
      if (nums.includes(String(id))) continue;
      const blocker = await dbId(repo, id);
      if (blocker) await api('DELETE', '/repos/' + repo + '/issues/' + n + '/dependencies/blocked_by/' + blocker);
    }
    return want.filter((id) => !nums.includes(id)).concat(stay);
  }
  // The issue's labels, state and body for a ticket, keeping labels that are not the room's.
  function shape(ticket, labels, extra, number) {
    const ours = Object.values(STATUS_LABELS).concat(PRIORITIES.map((p) => 'office:priority-' + p));
    const next = labels.filter((l) => !ours.includes(l.toLowerCase()));
    if (STATUS_LABELS[ticket.status]) next.push(STATUS_LABELS[ticket.status]);
    next.push('office:priority-' + (PRIORITIES.includes(ticket.priority) ? ticket.priority : 'normal'));
    const note = {};
    for (const [k, v] of Object.entries(ticket)) if (!NATIVE.includes(k)) note[k] = v;
    if (extra.length) note.blockedBy = extra;
    const closed = ticket.status === 'done' || ticket.status === 'rejected';
    return {
      title: ticket.title, body: withNote(ticket.body || '', note, number), labels: next,
      state: closed ? 'closed' : 'open', ...(closed ? { state_reason: ticket.status === 'done' ? 'completed' : 'not_planned' } : {})
    };
  }
  const warned = new Set();
  const ourLabels = (patch) => patch.labels.filter((l) => l.startsWith('office:'));

  return {
    name: 'github',
    async list(project) {
      const repo = repoOf(project);
      if (!repo) return [];
      const c = cacheOf(project);
      if (!c.listedAt) await refresh(project, repo);
      else if (Date.now() - c.listedAt > TTL) refresh(project, repo).catch((e) => console.error('Ticket store (github): ' + e.message));
      return sorted(c);
    },
    async get(project, id) {
      const repo = repoOf(project);
      if (!repo || !isNumber(id)) return null;
      const c = cacheOf(project);
      if (c.tickets.has(String(id)) && (Date.now() - c.listedAt <= TTL || Date.now() - (c.wroteAt.get(String(id)) || 0) <= TTL)) return copy(c.tickets.get(String(id)));
      const t = await fetchOne(repo, id);
      if (t) return keep(project, t);  // a write, so a list already on its way does not put an older copy back
      c.tickets.delete(String(id));
      return null;
    },
    async create(project, fields) {
      const repo = repoOf(project);
      if (!repo) throw new Error('No GitHub repo keeps the tickets of channel ' + project + '. Set RELAY_TICKET_REPO.');
      const want = (fields.blockedBy || []).map(String);
      const ticket = Object.assign({}, fields);
      for (const k of ['id', 'createdAt', 'updatedAt']) delete ticket[k];
      await ensureLabels(repo, ourLabels(shape(ticket, [], [], 0)));
      // The note is signed with the issue number, so the issue is opened first, with no label: until the
      // PATCH below gives it one, it is not a ticket.
      let issue = await api('POST', '/repos/' + repo + '/issues', { title: ticket.title, body: ticket.body || '' });
      const n = issue.number;
      dbIds.set(repo + ' #' + n, issue.id);
      try {
        const extra = await setBlockers(repo, n, [], want);
        issue = await api('PATCH', '/repos/' + repo + '/issues/' + n, shape(ticket, labelNames(issue), extra, n));
        return keep(project, ticketOf(issue, want.filter((id) => !extra.includes(id)).map(Number)));
      } catch (e) {
        // The issue has no label, so it is not a ticket. Close it, so a retry does not leave two open.
        await api('PATCH', '/repos/' + repo + '/issues/' + n, { state: 'closed', state_reason: 'not_planned' }).catch(() => {});
        throw e;
      }
    },
    async update(project, id, changes) {
      const repo = repoOf(project);
      if (!repo || !isNumber(id)) return null;
      let issue;
      try { issue = await api('GET', '/repos/' + repo + '/issues/' + id); } catch (e) { if (gone(e)) return null; throw e; }
      if (!isTicket(issue)) return null;
      const now = await blockersOf(repo, issue);
      const { id: _id, createdAt: _at, updatedAt: _up, ...rest } = changes;
      const ticket = Object.assign(ticketOf(issue, now), rest);
      const want = (ticket.blockedBy || []).map(String);
      // A note this key did not sign is kept as it is, so a lost or new key cannot write the folder it
      // falls back to over the real one. What only the note holds cannot change until the note checks.
      const foreign = foreignNote(issue);
      if (foreign) {
        const held = Object.keys(rest).filter((k) => !NATIVE.includes(k)).concat('blockedBy' in rest && want.some((b) => !isNumber(b)) ? ['blockedBy'] : []);
        if (held.length) throw new Error('Issue #' + issue.number + ' has a note this relay\'s key did not sign, so its ' + held.join(', ') + ' cannot change. Check RELAY_TICKET_KEY_FILE, or take the note out of the issue.');
        if (!warned.has(repo + ' #' + issue.number)) { warned.add(repo + ' #' + issue.number); console.error('Ticket store (github): issue #' + issue.number + ' has a note this relay\'s key did not sign. It is kept as it is, and the ticket works in ' + FOLDER + '.'); }
      }
      const extra = 'blockedBy' in rest ? await setBlockers(repo, issue.number, now, want) : want.filter((b) => !now.includes(Number(b)));
      const patch = shape(ticket, labelNames(issue), extra, issue.number);
      if (foreign) patch.body = (ticket.body ? ticket.body + '\n\n' : '') + foreign;
      await ensureLabels(repo, ourLabels(patch));
      const after = await api('PATCH', '/repos/' + repo + '/issues/' + issue.number, patch);
      return keep(project, ticketOf(after, want.filter((b) => !extra.includes(b)).map(Number)));
    }
  };
}
module.exports = { open, repos };
