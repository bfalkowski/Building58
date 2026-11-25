// Tickets: work that exists before anyone starts on it. Anyone can file one. What an agent files
// waits in Triage for a person; what a person files is Ready. Starting a ticket makes a task
// (relay/tasks.js), which brings the checkout and the worker. See docs/manual/roles.html#life.
//
// Where tickets are kept is up to the store: see relay/ticket-stores/local.js.
'use strict';
const { keepLines, oneLine } = require('./clean.js');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const terminal = require('./terminal.js');
const delivery = require('./delivery.js');
const tasks = require('./tasks.js');
const checkouts = require('./checkouts.js');
const chat = require('./chat.js');
const history = require('./ticket-history.js');
const config = require('./config.js');
const pmNotes = require('./pm-notes.js');
const { pmBrief, standingBrief } = require('./pm-brief.js');
const { boardOrder, firstRank, lastRank, placeNear } = require('./ticket-order.js');
const { heldBack, MARKS, proposalWords } = require('./autopilot-plan.js');
const { likelyTwins } = require('./ticket-twins.js');
const { writeLine } = require('./needs-you-plan.js');
const notes = require('./ticket-notes.js');
const trust = require('./pm-trust.js');
const pmCheck = require('./pm-check.js');
const { ANSWERS } = require('./pm-check-brief.js');

const STATUSES = ['triage', 'ready', 'started', 'done', 'rejected'];
const PRIORITIES = ['high', 'normal', 'low'];
const KINDS = ['docs', 'tests', 'bug', 'feature', 'jam'];
const JAM = 'jam';
const KIND = /^[a-z][a-z0-9-]{0,23}$/;
const kindsOf = (all) => [...new Set(KINDS.concat(all.map((t) => t.kind).filter((k) => typeof k === 'string' && k)))];
function kindFrom(value, all, agent) {
  const kind = clean(value).toLowerCase();
  if (!kind) return { kind: null };
  if (!KIND.test(kind)) return { error: [400, { ok: false, error: 'bad_kind', message: 'A kind is one short word: a lowercase letter, then letters, digits or dashes, up to 24 in all, such as docs or tests.' }] };
  const known = kindsOf(all);
  if (agent && !known.includes(kind)) return { error: [400, { ok: false, error: 'bad_kind', message: 'Kind is one of: ' + known.join(', ') + '. Only the person adds a new kind.' }] };
  return { kind };
}
const MAX_LABELS = 5;
const labelsOf = (all) => [...new Set(all.flatMap((t) => (Array.isArray(t.labels) ? t.labels : [])))].sort();
function labelsFrom(value, all, agent) {
  if (value === undefined || value === null) return { labels: [] };
  const list = Array.isArray(value) ? value : String(value).split(',');
  const labels = [...new Set(list.map((l) => clean(l).toLowerCase()).filter(Boolean))];
  if (labels.some((l) => !KIND.test(l))) return { error: [400, { ok: false, error: 'bad_label', message: 'A label is one short word: a lowercase letter, then letters, digits or dashes, up to 24 in all, such as flaky or follow-up.' }] };
  if (labels.length > MAX_LABELS) return { error: [400, { ok: false, error: 'bad_label', message: 'A ticket has at most ' + MAX_LABELS + ' labels.' }] };
  const known = labelsOf(all), unknown = labels.filter((l) => !known.includes(l) && !(agent && agent.role === 'manager' && l === 'manager'));
  if (agent && unknown.length) return { error: [400, { ok: false, error: 'bad_label', message: 'No ticket has the label ' + unknown.join(', ') + ' yet. ' + (known.length ? 'Labels are: ' + known.join(', ') + '. ' : '') + 'Only the person adds a new label.' }] };
  return { labels };
}
const MOVES = { triage: ['ready', 'rejected', 'done'], ready: ['rejected', 'done'], started: ['ready'], rejected: ['triage'] };
const PR_LINK = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d{0,9}$/;
const MAX_TITLE = 80, MAX_BODY = 8000, MAX_TRIAGE = 20;
const PM_PARTS = ['What to build', 'Acceptance criteria', 'Blocked by', 'Out of scope'];
const partsMissing = (text) => PM_PARTS.filter((part) => !new RegExp('^[\\s#*_>-]*' + part + '\\b', 'im').test(text));
const CLI = path.join(__dirname, 'ticket.js');

function openStore() {
  const spec = process.env.RELAY_TICKET_STORE || 'local';
  return require(spec === 'local' ? './ticket-stores/local.js' : path.resolve(spec)).open();
}
const store = openStore();

tasks.events.on('state', async (channel, task) => {
  if (!task.ticket) return;
  try {
    const t = await store.get(channel, task.ticket);
    if (t && t.createdAt === task.ticketAt) await store.update(channel, t.id, { status: task.state === 'done' ? 'done' : 'started' });
  } catch (e) { if (!e.waits) console.error('Ticket store (' + store.name + '): ' + e.message); }
});

tasks.onClean(async (channel, task) => {
  if (!task.ticket) return;
  const t = await store.get(channel, task.ticket);
  const prs = [...new Set((task.history || []).filter((h) => h.type === 'pr' && h.pr).map((h) => h.pr).concat(task.pr ? [task.pr] : []))];
  if (!t || t.createdAt !== task.ticketAt) return;
  await store.update(channel, t.id, { status: 'done' });
  if (!prs.length) return;
  try { await store.update(channel, t.id, { taskPrs: prs }); } catch (e) { console.error('Ticket store (' + store.name + ') could not keep the PRs of its task on ' + t.id + ', so Merged elsewhere will not refuse them: ' + e.message); }
});

if (store.local) chat.onTicketSummary(async (channel, id, ticketAt, summary) => {
  const t = await store.get(channel, id);
  if (!t || t.createdAt !== ticketAt) return false;
  await store.update(channel, t.id, { chatSummary: summary });
  return true;
});

chat.onFindTicket((channel, id) => store.get(channel, id));
const chatOf = (t) => ({ ticket: t.id, ticketAt: t.createdAt, title: t.title });

const queues = new Map();
function inTurn(channel, fn) {
  const run = (queues.get(channel) || Promise.resolve()).then(fn, fn);
  queues.set(channel, run.catch(() => {}));
  return run;
}

const clean = (v) => keepLines(v).trim();

const blockersOf = (ticket, all, statuses) => (ticket.blockedBy || []).filter((id) => { const b = all.find((x) => x.id === id); return b && statuses.includes(b.status); });
const waitingFor = (ticket, all) => blockersOf(ticket, all, ['triage', 'ready', 'started']);
const startedBy = (task) => task.by || ((task.history || []).find((h) => h.type === 'created') || {}).by || 'you';
const unreadNotes = (channel) => (typeof store.unreadNotes === 'function' ? store.unreadNotes(channel) : { count: 0, ids: [], line: null });
const writeErrors = (channel, now) => (typeof store.writeErrors === 'function' ? store.writeErrors(channel) : []).map((w) => Object.assign({}, w, { inMs: w.nextAt - now }));
const needsYouOf = (channel) => require('./needs-you.js').boardOf(channel, Date.now());
async function view(channel, ticket, all, needs) {
  const task = tasks.ofTicket(channel, ticket);
  const { assignee, history: steps } = history.view(channel, ticket, task);
  const board = task && task.state !== 'done' && (needs === undefined ? needsYouOf(channel) : needs);
  const look = board ? board.get(task.id) || { needsYou: null, reviewRuns: false } : null;
  const failed = writeErrors(channel, Date.now()).find((w) => w.id === ticket.id);
  return Object.assign({}, ticket, { writeError: failed ? writeLine(failed) : null, assignee, history: steps, approved: personApproved(ticket), notes: Array.isArray(ticket.notes) ? ticket.notes : [], proposal: ticket.proposal || undefined, heldBack: heldBack(ticket, all), waitingFor: waitingFor(ticket, all), rejectedBlockers: blockersOf(ticket, all, ['rejected']), task: task ? Object.assign({ id: task.id, state: task.state, branch: task.branch, pr: task.pr, by: startedBy(task), startedAt: task.createdAt, pipeline: task.pipeline, waitsOn: task.waitsOn || null }, look) : null });
}
async function followTasks(channel, list) {
  for (const t of list) {
    if (t.status !== 'started' && t.status !== 'done') continue;
    const task = tasks.ofTicket(channel, t);
    const should = task && (task.state === 'done' ? 'done' : 'started');
    if (!should || should === t.status) continue;
    try { Object.assign(t, await store.update(channel, t.id, { status: should })); } catch (e) { if (!e.waits) console.error('Ticket store (' + store.name + ') could not move ' + t.id + ' to ' + should + ': ' + e.message); }
  }
  return list;
}
async function listAll(channel) { return followTasks(channel, await store.list(channel)); }

async function create(channel, body, agent) {
  const title = clean(body.title).replace(/\s+/g, ' ');
  if (!title) return [400, { ok: false, error: 'bad_title', message: 'A ticket needs a title.' }];
  if (title.length > MAX_TITLE) return [400, { ok: false, error: 'bad_title', message: 'Keep the title to ' + MAX_TITLE + ' characters.' }];
  const text = clean(body.body);
  if (text.length > MAX_BODY) return [400, { ok: false, error: 'bad_body', message: 'Keep the body to ' + MAX_BODY + ' characters.' }];
  const missing = agent && agent.role === 'pm' ? partsMissing(text) : [];
  if (missing.length) return [400, { ok: false, error: 'bad_body', message: 'A PM ticket\'s body has the parts What to build, Acceptance criteria, Blocked by and Out of scope, each at the start of its own line, such as "Blocked by: none". Missing: ' + missing.join(', ') + '.' }];
  const priority = body.priority === undefined ? 'normal' : String(body.priority);
  if (!PRIORITIES.includes(priority)) return [400, { ok: false, error: 'bad_priority', message: 'Priority is one of: ' + PRIORITIES.join(', ') + '.' }];
  const from = agent ? agent.cwd : terminal.expand(body.repo);
  let repo;
  try { repo = await tasks.mainCheckout(from); } catch (e) {
    return [400, { ok: false, error: 'bad_repo', message: e.code === 'ENOENT' ? 'There is no folder ' + from + '.' : 'A ticket needs a git repo: ' + from }];
  }
  let base;
  const pmBase = agent && agent.role === 'pm' ? checkouts.pmBaseOf(agent.channel, from) : null;
  try { base = pmBase || await (agent && agent.role !== 'pm' ? tasks.defaultBranch(repo) : tasks.branchOf(from)); } catch (e) {
    if (e.noBranch) return [400, { ok: false, error: 'no_branch', message: e.message }];
    return [500, { ok: false, error: 'git', message: 'Git could not read the branch of ' + from + ': ' + e.message }];
  }
  const unusable = tasks.baseProblem(base);
  if (unusable) return [400, { ok: false, error: 'bad_base', message: unusable }];
  return inTurn(channel, () => file(channel, { title, text, priority, repo, base, blockedBy: body.blockedBy, shapes: body.shapes, kind: body.kind, labels: body.labels }, agent));
}
async function fileAsManager(channel, { title, body, repo }) {
  const main = await tasks.mainCheckout(repo);
  const base = await tasks.defaultBranch(main);
  return inTurn(channel, () => file(channel, { title: clean(title).replace(/\s+/g, ' ').slice(0, MAX_TITLE), text: clean(body).slice(0, MAX_BODY), priority: 'normal', repo: main, base, labels: ['manager'] }, { role: 'manager', cwd: main }));
}
const MANAGER = { role: 'manager', cwd: '' };
const noteAsManager = (channel, id, text) => addNote(channel, { id }, { text }, MANAGER);
async function file(channel, { title, text, priority, repo, base, blockedBy: asked, shapes: askedShapes, kind: askedKind, labels: askedLabels }, agent) {
  const all = await listAll(channel);
  const { kind, error } = kindFrom(askedKind, all, agent);
  if (error) return error;
  const { labels, error: badLabels } = labelsFrom(askedLabels, all, agent);
  if (badLabels) return badLabels;
  const blockedBy = [...new Set((Array.isArray(asked) ? asked : []).map((id) => String(id).trim()))];
  const spaced = blockedBy.filter((id) => /\s/.test(id));
  if (spaced.length) return [400, { ok: false, error: 'bad_blocker', message: 'Separate blocker ids with commas, not spaces: --blocked-by ' + blockedBy.flatMap((id) => id.split(/[\s,]+/)).filter(Boolean).join(',') + '.' }];
  const unknown = blockedBy.filter((id) => !all.some((t) => t.id === id));
  if (unknown.length) return [400, { ok: false, error: 'bad_blocker', message: 'No such ticket: ' + unknown.join(', ') + '. Run ticket.js list to see the ids, and give each one that exists, separated by commas.' }];
  const { shapes, error: badShapes } = shapesFrom(askedShapes, all, null);
  if (badShapes) return badShapes;
  const live = all.filter((t) => t.status !== 'done' && t.status !== 'rejected');
  const same = (agent ? all.filter((t) => t.status !== 'done') : live).find((t) => t.repo === repo && t.title.toLowerCase() === title.toLowerCase() && (!t.base || t.base === base));
  if (same) return [200, { ok: true, duplicate: true, ticket: await view(channel, same, all) }];
  const approvedOnes = agent ? shapes.filter((id) => all.find((t) => t.id === id).status !== 'triage') : [];
  if (approvedOnes.length) return [403, { ok: false, error: 'bad_shapes', message: 'A session names only tickets in Triage with --shapes. ' + approvedOnes.join(', ') + ' left Triage, so only the person can make ' + (approvedOnes.length > 1 ? 'them' : 'it') + ' wait for a design ticket.' }];
  if (agent && all.filter((t) => t.status === 'triage').length >= MAX_TRIAGE) {
    return [429, { ok: false, error: 'triage_full', message: 'Triage already has ' + MAX_TRIAGE + ' tickets waiting for a person. Stop filing and carry on.' }];
  }
  if (kind === JAM) priority = 'high';
  const rank = kind === JAM ? firstRank(all, priority, Date.now()) : lastRank(all, priority, Date.now());
  const ticket = await store.create(channel, Object.assign({ title, body: text, priority, rank, repo, base, blockedBy }, shapes.length ? { shapes } : {}, kind ? { kind } : {}, labels.length ? { labels } : {}, { status: agent ? 'triage' : 'ready', createdBy: agent ? agentName(agent) : 'you' }, agent ? {} : { approvedBy: 'you' }));
  history.add(channel, ticket, { stage: 'filed', by: ticket.createdBy }, agent || null);
  chat.openTicketRoom(channel, chatOf(ticket));
  filed(channel, ticket, agent, ticket.createdAt);
  return [201, { ok: true, ticket: await view(channel, ticket, all.concat(ticket)), likely: likelyTwins(ticket, live) }];
}
const agentName = (t) => (t.role === 'manager' ? 'Manager' : t.role === 'pm' ? 'PM' : t.role === 'coo' ? 'COO' : t.lead ? 'Lead' : t.title ? 'Worker on ' + t.title : 'Session ' + t.sessionId.slice(0, 8)).slice(0, 60);

async function move(channel, ticket, body, agent) {
  const to = String(body.to || '');
  const pr = clean(body.pr);
  const mayMove = !starting.has(channel + '/' + ticket.id) && !tasks.ofTicket(channel, ticket) && (MOVES[ticket.status] || []).includes(to);
  const asked = !!agent && to === 'done' && mayMove && PR_LINK.test(pr);
  const doubt = asked && await prDoubt(ticket, pr);
  if (doubt) return [409, { ok: false, error: doubt[0], message: doubt[1] }];
  return inTurn(channel, async () => {
    const all = await store.list(channel);
    const now = all.find((t) => t.id === ticket.id) || ticket;
    if (starting.has(channel + '/' + now.id)) return [409, { ok: false, error: 'started', message: 'This ticket is starting. Once it has, move its task instead.' }];
    if ((to === 'done' || now.status === 'started') && tasks.ofTicket(channel, now)) return [409, { ok: false, error: 'started', message: now.status === 'started' ? 'This ticket has a task. Move its task instead.' : 'This ticket has a task. It is done when its task is.' }];
    if (agent && now.status === 'started' && to === 'ready') return [403, { ok: false, error: 'forbidden', message: 'Only the person moves a started ticket back to Ready.' }];
    if (!(MOVES[now.status] || []).includes(to)) return [409, { ok: false, error: 'bad_move', message: 'A ' + now.status + ' ticket cannot move to ' + (to || 'nothing') + ' from here.' }];
    if (to === 'done' && !PR_LINK.test(pr)) return [400, { ok: false, error: 'bad_pr', message: 'To mark a ticket done without a task, give the link of the PR that merged it, such as https://github.com/owner/repo/pull/12.' }];
    if (agent && to === 'done' && !asked) return [409, { ok: false, error: 'changed', message: now.id + ' changed while this move waited, so the relay did not check ' + pr + ' with gh. Move it again.' }];
    const owner = to === 'done' && prOwner(channel, pr, now, all);
    if (owner) return [409, { ok: false, error: 'pr_taken', message: pr + ' is already the PR of ' + owner + ', so it cannot mark ' + now.id + ' done. Give the PR that delivered ' + now.id + '.' }];
    const changes = Object.assign({ status: to }, now.proposal && (to === 'rejected' || to === 'done') ? { proposal: null } : {}, now.closedAs && to === 'triage' ? { closedAs: null, closedFor: null } : {}, to === 'done' ? { pr } : {}, to === 'ready' && now.status === 'started' ? {} : to === 'ready' ? { approvedBy: agent ? 'Lead' : 'you' } : now.status === 'ready' ? { approvedBy: 'none' } : {});
    const moved = await store.update(channel, now.id, changes, { person: !agent });
    if (to === 'done' || to === 'rejected') chat.archiveTicketRoom(channel, now.id, now.createdAt, to === 'done' ? 'the ticket moved to Done' : 'the ticket was rejected');
    else if (now.status === 'rejected') chat.openTicketRoom(channel, chatOf(moved));
    history.add(channel, now, to === 'ready' && now.status !== 'started' ? { stage: 'approved', by: agent ? 'Lead' : 'you' } : { stage: 'moved', from: now.status, to, by: agent ? 'Lead' : 'you' }, agent || null);
    return [200, { ok: true, ticket: await view(channel, moved, all) }];
  });
}

const GH = process.env.GH_CMD || 'gh';
const run = (cmd, args, cwd) => new Promise((done) => (cmd === GH && require('./gh.js').count(args), execFile(cmd, args, { cwd, timeout: 20000, env: Object.assign({}, process.env, { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }) }, (err, out, errOut) => done(err ? { err: String(errOut || err.message).trim().split('\n')[0] } : { out }))));
const ownerRepo = (link) => { const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(link) || /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\//i.exec(link); return m ? (m[1] + '/' + m[2]).toLowerCase() : null; };
async function prDoubt(ticket, pr) {
  if (!ticket.repo || !fs.existsSync(ticket.repo)) return ['pr_unchecked', ticket.id + ' names no repo on this computer, so the relay cannot check that ' + pr + ' merged there. Ask the person to mark it Done.'];
  const view = await run(GH, ['pr', 'view', pr, '--json', 'state,url'], ticket.repo);
  let got = null;
  try { got = view.out && JSON.parse(view.out); } catch (e) { got = null; }
  if (!got || !got.state) return ['pr_unchecked', 'gh could not read ' + pr + (view.err ? ': ' + view.err : '') + '. Check the link, or ask the person to mark ' + ticket.id + ' Done.'];
  if (got.state !== 'MERGED') return ['pr_not_merged', pr + ' has not merged: it is ' + String(got.state).toLowerCase() + '. Mark ' + ticket.id + ' Done once it merges.'];
  const remotes = await run('git', ['remote', '-v'], ticket.repo);
  const here = [...new Set(String(remotes.out || '').split('\n').map((l) => ownerRepo(l.split(/\s+/)[1] || '')).filter(Boolean))];
  const at = ownerRepo(got.url || pr);
  if (!here.includes(at) && !here.includes(ownerRepo(pr))) return ['pr_elsewhere', pr + ' is in ' + at + ', not in ' + (here.join(' or ') || 'a GitHub repo') + ', the repo of ' + ticket.id + '. Give the PR that delivered ' + ticket.id + '.'];
  return null;
}

function prOwner(channel, pr, ticket, all) {
  const same = (x) => typeof x === 'string' && x.toLowerCase() === pr.toLowerCase();
  const task = tasks.list(channel).find((x) => same(x.pr) || (x.history || []).some((h) => h.type === 'pr' && same(h.pr)));
  if (task) return 'task ' + task.id + (task.ticket ? ' (' + task.ticket + ')' : '') + ' · ' + task.title;
  const other = all.find((t) => t.id !== ticket.id && (same(t.pr) || (t.taskPrs || []).some(same)));
  return other ? 'ticket ' + other.id + ' · ' + other.title : null;
}

function shapesFrom(value, all, self) {
  if (value === undefined || value === null) return { shapes: [] };
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string' && typeof x !== 'number')) return { error: [400, { ok: false, error: 'bad_shapes', message: '"shapes" is a list of ticket ids.' }] };
  const shapes = [...new Set(value.map((x) => clean(x)).filter(Boolean))];
  if (self && shapes.includes(self)) return { error: [400, { ok: false, error: 'bad_shapes', message: 'A ticket cannot shape itself.' }] };
  const unknown = shapes.filter((id) => !all.some((t) => t.id === id));
  if (unknown.length) return { error: [400, { ok: false, error: 'bad_shapes', message: 'No such ticket: ' + unknown.join(', ') + '.' }] };
  return { shapes };
}
const ORDERABLE = ['triage', 'ready'];
const notReady = (agent, what, state) => [agent ? 403 : 409, { ok: false, error: 'not_ready', message: 'Only a ticket in Triage or Ready can change its ' + what + '. This one is ' + state + '.' }];
const setBy = (agent, what) => ({ orderedBy: !agent ? 'you' : agent.lead ? 'Lead' : 'PM', orderedWhat: what });
const NOT_YOURS = 'Only the person sets a ticket\'s priority and place in the work order, and a PM or Lead they let set it.';
function leadMayOrder(channel, id) {
  if (config.get('leadOrder')) return null;
  const off = 'The person has not let the Lead set priority. They turn it on with Let the Lead set priority in Settings. Until then, recommend an order and let them set it.';
  if (!config.get('leadUnstick') || !id) return off;
  const why = require('./failures.js').ticketMay(channel, id);
  return why ? off + ' Let the Lead unstick the board allows it only for a ticket linked to an open failure channel, while no blocked Dev runs. ' + why : null;
}
function sessionMayOrder(channel, agent, id) {
  if (agent.lead) return leadMayOrder(channel, id);
  if (agent.role !== 'pm') return NOT_YOURS;
  if (!trust.may(trust.ORDER)) return 'The person has not let the PM set the order. They raise PM trust to Order in Settings. Until then, recommend an order and let them set it.';
  const newest = terminal.all(channel).filter((t) => t.role === 'pm').sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
  if (newest !== agent) return 'Another PM started after this one, and only the newest PM may set the order.';
  return null;
}
function orderOff(channel, agent, id) {
  const no = agent && sessionMayOrder(channel, agent, id);
  return no ? [403, { ok: false, error: 'forbidden', message: no }] : null;
}
const noteBy = (agent) => (!agent ? 'you' : agent.role === 'relay' ? 'the relay' : agent.role === 'reviewer' || agent.reviewOf ? 'Reviewer' : oneLine(agentName(agent), 60));
function addNote(channel, ticket, body, agent) {
  const text = clean(body.text);
  if (!text) return [400, { ok: false, error: 'bad_note', message: 'A note needs words.' }];
  if (text.length > notes.MAX_NOTE) return [400, { ok: false, error: 'bad_note', message: 'Keep the note to ' + notes.MAX_NOTE + ' characters.' }];
  return inTurn(channel, async () => {
    const now = await store.get(channel, ticket.id);
    if (!now) return [404, { ok: false, error: 'no_ticket', message: 'No such ticket on this channel.' }];
    if ((now.notes || []).length >= notes.MAX_NOTES) return [409, { ok: false, error: 'notes_full', message: now.id + ' keeps ' + notes.MAX_NOTES + ' notes. Nothing removes a note, so it takes no more. Put what the next session needs in a post on the ticket chat, or tell the person or the Lead, who can fold it into the body.' }];
    const note = { by: noteBy(agent), role: agent ? oneLine(history.roleOf(agent) || '', 12) || null : null, at: new Date().toISOString(), text };
    const noted = typeof store.addNote === 'function' ? await store.addNote(channel, now.id, note) : await store.update(channel, now.id, { notes: (now.notes || []).concat(note) });
    if (!noted) return [404, { ok: false, error: 'no_ticket', message: 'No such ticket on this channel.' }];
    const all = await listAll(channel);
    return [200, { ok: true, ticket: await view(channel, noted, all.map((t) => (t.id === noted.id ? noted : t))) }];
  });
}
const PROPOSALS = ['replace', 'merge', 'close', 'blockers'];
const CLOSED_AS = { replace: 'replaced', merge: 'merged', close: 'closed' };
const MAX_WHY = 500;
function proposalFrom(body) {
  const bad = (message) => ({ error: [400, { ok: false, error: 'bad_proposal', message }] });
  const action = String(body.action || '');
  if (!PROPOSALS.includes(action)) return bad('A proposal is one of: ' + PROPOSALS.join(', ') + '.');
  const given = body.ids === undefined || body.ids === null ? [] : body.ids;
  if (!Array.isArray(given) || given.some((x) => typeof x !== 'string' && typeof x !== 'number')) return bad('"ids" is a list of ticket ids.');
  const ids = [...new Set(given.map((x) => clean(x)).filter(Boolean))];
  if (action === 'replace' && !ids.length) return bad('Name the tickets that replace it.');
  if (action === 'merge' && ids.length !== 1) return bad('Name the one ticket it merges into.');
  if (action === 'close' && ids.length) return bad('Closing names no other ticket. To point at the tickets that take its place, propose replace.');
  const why = oneLine(body.why || '');
  if (why.length > MAX_WHY) return bad('Keep the reason to ' + MAX_WHY + ' characters.');
  return { proposal: { action, ids, why } };
}
function waitsOn(from, target, all, seen) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const t = all.find((x) => x.id === from);
  return !!t && (t.blockedBy || []).some((b) => waitsOn(b, target, all, seen));
}
function proposalProblem(now, p, all) {
  if (p.ids.includes(now.id)) return p.action === 'blockers' ? 'A ticket cannot block itself.' : 'A ticket cannot go into itself.';
  const unknown = p.ids.filter((id) => !all.some((t) => t.id === id));
  if (unknown.length) return 'No such ticket: ' + unknown.join(', ') + '.';
  const gone = p.ids.filter((id) => all.find((t) => t.id === id).status === 'rejected');
  if (gone.length) return gone.join(', ') + (gone.length > 1 ? ' were' : ' was') + ' rejected, so ' + now.id + (p.action === 'blockers' ? ' cannot wait for ' : ' cannot go into ') + (gone.length > 1 ? 'them' : 'it') + '.';
  if (p.action !== 'blockers') return null;
  const loop = p.ids.find((id) => waitsOn(id, now.id, all, new Set()));
  return loop ? loop + ' already waits for ' + now.id + ', so ' + now.id + ' cannot wait for it.' : null;
}
function propose(channel, ticket, body, agent) {
  const { proposal, error } = proposalFrom(body);
  if (error) return error;
  return inTurn(channel, async () => {
    const all = await listAll(channel);
    const now = all.find((t) => t.id === ticket.id) || ticket;
    const state = starting.has(channel + '/' + now.id) ? 'starting' : now.status;
    if (!ORDERABLE.includes(state)) return [agent ? 403 : 409, { ok: false, error: 'not_ready', message: 'Only a ticket in Triage or Ready takes a proposal. This one is ' + state + '.' }];
    const problem = proposalProblem(now, proposal, all);
    if (problem) return [400, { ok: false, error: 'bad_proposal', message: problem }];
    const by = !agent ? 'you' : agent.lead ? 'Lead' : 'PM';
    Object.assign(proposal, { by, at: new Date().toISOString() });
    const changed = await store.update(channel, now.id, { proposal });
    history.add(channel, now, { stage: 'proposal', by, action: proposal.action, ids: proposal.ids, why: proposal.why || null }, agent || null);
    const message = (by === 'you' ? 'You propose' : 'The ' + by + ' proposes') + ' to ' + proposalWords(proposal, now.id) + '. Nothing changes until the person approves or declines it on the Board.';
    return [200, { ok: true, message, ticket: await view(channel, changed, all.map((t) => (t.id === now.id ? changed : t))) }];
  });
}
function decide(channel, ticket, body, by = 'you') {
  const decision = String((body && body.decision) || '');
  if (!['approve', 'decline'].includes(decision)) return [400, { ok: false, error: 'bad_param', message: '"decision" is approve or decline.' }];
  return inTurn(channel, async () => {
    const all = await listAll(channel);
    const now = all.find((t) => t.id === ticket.id) || ticket;
    const p = now.proposal;
    if (!p) return [409, { ok: false, error: 'no_proposal', message: 'No proposal waits on ' + now.id + '.' }];
    const step = { by, action: p.action, ids: p.ids, from: p.by };
    if (decision === 'decline') {
      const changed = await store.update(channel, now.id, { proposal: null });
      history.add(channel, now, Object.assign({ stage: 'proposal-declined' }, step));
      return [200, { ok: true, ticket: await view(channel, changed, all.map((t) => (t.id === now.id ? changed : t))) }];
    }
    const state = starting.has(channel + '/' + now.id) ? 'starting' : now.status;
    if (!ORDERABLE.includes(state)) return [409, { ok: false, error: 'not_ready', message: now.id + ' is ' + state + ' now, so the proposal no longer fits. Decline it.' }];
    const problem = proposalProblem(now, p, all);
    if (problem) return [409, { ok: false, error: 'stale', message: problem + ' Decline the proposal, or change the Board first.' }];
    const changes = p.action === 'blockers' ? { blockedBy: p.ids, proposal: null }
      : Object.assign({ status: 'rejected', closedAs: CLOSED_AS[p.action], closedFor: p.ids, proposal: null }, now.status === 'ready' ? { approvedBy: 'none' } : {});
    const changed = await store.update(channel, now.id, changes);
    history.add(channel, now, Object.assign({ stage: 'proposal-approved' }, step));
    if (changes.status === 'rejected') chat.archiveTicketRoom(channel, now.id, now.createdAt, 'the ticket was ' + CLOSED_AS[p.action]);
    return [200, { ok: true, ticket: await view(channel, changed, all.map((t) => (t.id === now.id ? changed : t))) }];
  });
}

async function leadMergesTwin(channel, ticket, body) {
  const failures = require('./failures.js'), into = Array.isArray(body.ids) ? body.ids[0] : null;
  return body.action === 'merge' && config.get('leadUnstick') && !!into && failures.bothLinked(channel, ticket.id, into);
}
async function carryOut(channel, ticket) {
  const decided = await decide(channel, ticket, { decision: 'approve' }, 'Lead');
  if (!decided[1].ok) return decided;
  const note = await addNote(channel, ticket, { text: 'Let the Lead unstick the board is on, and both tickets are linked to one failure channel, so the relay merged this one into ' + (decided[1].ticket.closedFor || []).join(', ') + '. To bring it back, move it to Triage.' }, RELAYER);
  return [200, Object.assign({ ok: true, message: 'Merged ' + ticket.id + ' into ' + (decided[1].ticket.closedFor || []).join(', ') + '.' }, note[1].ok ? { ticket: note[1].ticket } : { ticket: decided[1].ticket })];
}
const RELAYER = { role: 'relay', who: 'the relay', sessionId: 'relay' };
async function closeForFailure(channel, ids, pr, others, key) {
  const n = (link) => '#' + String(link).split('/').pop();
  for (const id of ids) {
    const closed = await inTurn(channel, async () => {
      const all = await listAll(channel), now = all.find((t) => t.id === id);
      if (!now || !ORDERABLE.includes(now.status) || starting.has(channel + '/' + id)) return null;
      await store.update(channel, id, Object.assign({ status: 'rejected', closedAs: 'closed', closedFor: [], proposal: null }, now.status === 'ready' ? { approvedBy: 'none' } : {}));
      history.add(channel, now, { stage: 'moved', from: now.status, to: 'rejected', by: 'relay', pr });
      chat.archiveTicketRoom(channel, id, now.createdAt, 'PR ' + n(pr) + ' fixed the failure ' + key);
      return now;
    });
    if (closed) await addNote(channel, closed, { text: 'The check ' + key + ' was fixed by PR ' + n(pr) + ', which merged, so the relay closed this ticket.' + (others.length ? ' It also blocked ' + others.map(n).join(', ') + '.' : '') }, RELAYER);
  }
  changed(channel);
}
const ADVICE_WORDS = { start: 'start', first: 'another first', 'not-needed': 'not needed', duplicate: 'a duplicate', 'part-of': 'part of another ticket' };
const HOLDS = { 'not-needed': 'close', duplicate: 'merge', 'part-of': 'merge' };
function adviceFrom(body) {
  const bad = (message) => ({ error: [400, { ok: false, error: 'bad_advice', message }] });
  const answer = String(body.answer || '');
  if (!ANSWERS.includes(answer)) return bad('The answer is one of: ' + ANSWERS.join(', ') + '.');
  const why = oneLine(body.why || '');
  if (!why) return bad('Give the reason in one or two sentences, with --why.');
  if (why.length > MAX_WHY) return bad('Keep the reason to ' + MAX_WHY + ' characters.');
  const of = clean(body.of);
  if (answer !== 'start' && answer !== 'not-needed' && !of) return bad('Name the other ticket with --of.');
  if ((answer === 'start' || answer === 'not-needed') && of) return bad('"' + answer + '" names no other ticket.');
  return { advice: { answer, why, of: of || null } };
}
function advise(channel, ticket, body, agent) {
  if (!agent || agent.role !== 'pm') return [403, { ok: false, error: 'forbidden', message: 'Only the PM answers the check of a ticket.' }];
  if (!trust.may(trust.ADVISE)) return [403, { ok: false, error: 'forbidden', message: 'PM trust is Off, so the PM does not check tickets.' }];
  if (pmCheck.seat(channel) !== agent) return [403, { ok: false, error: 'forbidden', message: 'Another PM started after this one, and only the newest PM may answer the check.' }];
  const { advice, error } = adviceFrom(body);
  if (error) return error;
  return inTurn(channel, async () => {
    const all = await listAll(channel);
    const now = all.find((t) => t.id === ticket.id) || ticket;
    const state = starting.has(channel + '/' + now.id) ? 'starting' : now.status;
    if (!ORDERABLE.includes(state)) return [403, { ok: false, error: 'not_ready', message: 'Only a ticket in Triage or Ready takes advice. This one is ' + state + '.' }];
    const other = advice.of && all.find((t) => t.id === advice.of);
    if (advice.of && (!other || other.id === now.id)) return [400, { ok: false, error: 'bad_advice', message: 'No other ticket ' + advice.of + ' to name.' }];
    return [200, { advice, now }];
  }).then(async (checked) => {
    if (checked[0] !== 200) return checked;
    const { now } = checked[1];
    const rung = trust.level();
    const text = 'PM check, ' + ADVICE_WORDS[advice.answer] + (advice.of ? ' (' + advice.of + ')' : '') + ': ' + advice.why;
    const noted = await addNote(channel, now, { text }, agent);
    if (!noted[1].ok && noted[1].error !== 'notes_full') return noted;
    history.add(channel, now, { stage: 'pm-advice', by: 'PM', answer: advice.answer, of: advice.of, why: advice.why, rung }, agent);
    let did = 'advised';
    if (rung >= trust.HOLD && HOLDS[advice.answer]) {
      const proposed = await propose(channel, now, { action: HOLDS[advice.answer], ids: advice.of ? [advice.of] : [], why: advice.why }, agent);
      if (!proposed[1].ok) return [proposed[0], Object.assign({}, proposed[1], { message: 'Your advice is on the ticket, but the proposal was refused: ' + proposed[1].message })];
      did = 'proposed';
      if (rung >= trust.MERGE) {
        const decided = await decide(channel, now, { decision: 'approve' }, 'PM');
        if (!decided[1].ok) return [decided[0], Object.assign({}, decided[1], { message: 'Your advice is on the ticket and the proposal waits for the person, but carrying it out failed: ' + decided[1].message })];
        did = 'carried out';
        const carried = HOLDS[advice.answer] === 'merge' ? 'merged it into ' + advice.of : 'closed it';
        await addNote(channel, now, { text: 'PM trust is Close and merge, so the PM ' + carried + ': ' + advice.why + ' To bring it back, move it to Triage.' }, agent);
      }
    }
    pmCheck.answered(channel, now.id, advice, did);
    const fresh = await listAll(channel);
    const words = did === 'advised' ? 'Advice saved on ' + now.id + '.' : did === 'proposed' ? 'Advice saved on ' + now.id + ', and a proposal waits for the person, so it does not start.' : 'Advice saved on ' + now.id + ', and the relay carried it out.';
    return [200, { ok: true, did, answer: advice.answer, message: words, ticket: await view(channel, fresh.find((t) => t.id === now.id) || now, fresh) }];
  });
}

function setPlace(channel, ticket, body, agent) {
  const before = body.before === undefined ? null : String(body.before), after = body.after === undefined ? null : String(body.after);
  if ((before === null) === (after === null)) return [400, { ok: false, error: 'bad_param', message: 'Give one of "before" or "after": the id of the ticket to go next to.' }];
  const otherId = before === null ? after : before;
  return inTurn(channel, async () => {
    const off = orderOff(channel, agent, ticket.id);
    if (off) return off;
    const all = await listAll(channel);
    const stateOf = (t) => (starting.has(channel + '/' + t.id) ? 'starting' : t.status);
    const movable = (t) => ORDERABLE.includes(stateOf(t));
    const now = all.find((t) => t.id === ticket.id) || ticket;
    if (!movable(now)) return notReady(agent, 'place', stateOf(now));
    const other = all.find((t) => t.id === otherId);
    if (!other || other.id === now.id) return [400, { ok: false, error: 'bad_ticket', message: 'No other ticket ' + otherId + ' to go next to.' }];
    if (!movable(other)) return [409, { ok: false, error: 'not_ordered', message: other.id + ' is ' + stateOf(other) + '. Only Triage and Ready tickets are in the work order.' }];
    if ((other.priority || 'normal') !== (now.priority || 'normal')) return [409, { ok: false, error: 'other_priority', message: other.id + ' has ' + (other.priority || 'normal') + ' priority and ' + now.id + ' has ' + (now.priority || 'normal') + '. Change the priority first.' }];
    const writes = placeNear(all, now, other, after !== null, movable);
    await writeRanks(channel, all, writes, now.id, setBy(agent, 'place'));
    if (!writes.some(([id]) => id === now.id)) await store.update(channel, now.id, setBy(agent, 'place'));
    const fresh = await listAll(channel);
    return [200, { ok: true, ticket: await view(channel, fresh.find((t) => t.id === now.id), fresh) }];
  });
}
async function writeRanks(channel, all, writes, markId, mark) {
  const done = [];
  try {
    for (const [id, rank] of writes) { await store.update(channel, id, Object.assign({ rank }, id === markId ? mark : {})); done.push(id); }
  } catch (e) {
    const stuck = [];
    for (const id of done.reverse()) {
      try { await store.update(channel, id, { rank: all.find((t) => t.id === id).rank }); } catch (e2) { stuck.push(id); }
    }
    throw Object.assign(new Error('Moving the ticket failed partway: ' + e.message + (stuck.length ? ' The ranks of ' + stuck.join(', ') + ' could not be put back, so the order may be mixed. Move a ticket again to set it.' : ' The order is as it was before the move.')), { refused: !!e.refused });
  }
}

const personApproved = (t) => ('approvedBy' in t ? t.approvedBy === 'you' : t.createdBy === 'you');
const unsettled = (t, all) => (t.blockedBy || []).filter((id) => { const b = all.find((x) => x.id === id); return !b || b.status !== 'done'; });
const leadStarting = new Set();
const running = (channel, task) => { const w = terminal.find(channel, task.owner && task.owner.terminal); return !!(w && !w.exited); };
const unbriefedLeadTask = (channel) => tasks.list(channel).find((x) => x.by === 'Lead' && !x.briefed && running(channel, x)) || null;
function nextForLead(channel, all, self) {
  return boardOrder(all.filter((t) => t.status === 'ready' && t.repo && personApproved(t) && !unsettled(t, all).length && !heldBack(t, all) && !tasks.ofTicket(channel, t) && (t.id === self || !starting.has(channel + '/' + t.id))))[0] || null;
}
function leadMayStart(channel, ticket, all, agent) {
  if (ticket.status !== 'ready') return [409, { ok: false, error: 'not_ready', message: 'You can start only a Ready ticket. This one is ' + ticket.status + '.' }];
  if (!personApproved(ticket)) return [409, { ok: false, error: 'not_approved', message: 'No person approved ' + ticket.id + ' into Ready, so a person starts it.' }];
  const open = waitingFor(ticket, all);
  if (open.length) return [409, { ok: false, error: 'blocked', message: 'Waiting for ' + open.join(', ') + '.' }];
  const held = heldBack(ticket, all);
  if (held) return [409, { ok: false, error: 'held_back', message: ticket.id + ': ' + held + ' Only the person starts it.' }];
  const doubtful = unsettled(ticket, all);
  if (doubtful.length) return [409, { ok: false, error: 'blocker_not_done', message: doubtful.join(', ') + ' was rejected or is not on the Board, so a person decides whether ' + ticket.id + ' still goes ahead.' }];
  const unbriefed = unbriefedLeadTask(channel);
  if (unbriefed) return [409, { ok: false, error: 'one_at_a_time', message: 'The worker on ' + (unbriefed.ticket || 'task ' + unbriefed.id) + ' has not picked up its brief yet. Start the next one after it has.' }];
  const over = tasks.leadRefusal(channel, agent);
  if (over) return over;
  const next = nextForLead(channel, all, ticket.id);
  if (next && next.id !== ticket.id) return [409, { ok: false, error: 'not_next', message: 'Start ' + next.id + ' first: it comes before ' + ticket.id + ' on the Board.' }];
  return null;
}

const starting = new Set();
let holder = () => null;
const holdStarts = (fn) => { holder = fn; };
const heldWhy = (channel) => holder(channel);
async function start(channel, ticket, body, ctx) {
  const agent = ctx.agent;
  if (!agent) return startTicket(channel, ticket, body, ctx);
  const held = heldWhy(channel);
  if (held) return [409, { ok: false, error: 'held', message: held }];
  if (leadStarting.has(channel)) return [409, { ok: false, error: 'one_at_a_time', message: 'You are already starting a ticket. Start the next one after its worker has picked up its brief.' }];
  leadStarting.add(channel);
  try { return await startTicket(channel, ticket, body, ctx, agent); } finally { leadStarting.delete(channel); }
}
async function startTicket(channel, ticket, body, ctx, agent, by) {
  const key = channel + '/' + ticket.id;
  if (tasks.ofTicket(channel, ticket)) return [409, { ok: false, error: 'started', message: 'This ticket already has a task.' }];
  if (ticket.status !== 'ready' && ticket.status !== 'started') return [409, { ok: false, error: 'not_ready', message: 'Only a Ready ticket can start. This one is ' + ticket.status + '.' }];
  if (!ticket.repo) return [409, { ok: false, error: 'no_repo', message: 'This ticket names no repo to work in.' }];
  if (starting.has(key)) return [409, { ok: false, error: 'started', message: 'This ticket is already starting.' }];
  starting.add(key);
  try {
    let all, refused;
    [all, ticket, refused] = await inTurn(channel, async () => {
      const list = await listAll(channel);
      const now = list.find((t) => t.id === ticket.id) || ticket;
      if (now.status !== 'ready' && now.status !== 'started') return [list, now, [409, { ok: false, error: 'not_ready', message: 'Only a Ready ticket can start. This one is ' + now.status + '.' }]];
      const open = waitingFor(now, list);
      if (open.length) return [list, now, [409, { ok: false, error: 'blocked', message: 'Waiting for ' + open.join(', ') + '.' }]];
      const no = agent && leadMayStart(channel, now, list, agent);
      if (no) return [list, now, no];
      await store.update(channel, now.id, Object.assign({ status: 'started' }, now.proposal ? { proposal: null } : {}));
      if (now.proposal) history.add(channel, now, { stage: 'proposal-dropped', by: by || (agent ? 'Lead' : 'you'), action: now.proposal.action, ids: now.proposal.ids, from: now.proposal.by }, agent || null);
      return [list, now, null];
    });
    if (refused) return refused;
    const [status, out] = await tasks.create(channel, { title: ticket.title, brief: notes.withNotes(ticket.body, ticket.notes), repo: ticket.repo, base: ticket.base, ticket: ticket.id, ticketAt: ticket.createdAt, by: by || (agent ? 'Lead' : 'you'), lead: agent || undefined, cols: body.cols, rows: body.rows }, ctx);
    if (status >= 400) {
      const baseGone = out.error === 'no_base' && ticket.base;
      await store.update(channel, ticket.id, { status: baseGone ? 'ready' : ticket.status });
      return [status, baseGone ? { ...out, message: out.message + ' Change this ticket\'s base on the Board, then press Start again.' } : out];
    }
    return [200, { ok: true, ticket: await view(channel, await store.get(channel, ticket.id), all), task: out.task }];
  } finally { starting.delete(key); }
}

async function pmGround(from) {
  let top, base;
  try { top = await tasks.git(from, ['rev-parse', '--show-toplevel']); } catch (e) { return [400, { ok: false, error: 'bad_repo', message: 'The PM needs a git repo: ' + from }]; }
  try { base = await tasks.branchOf(top); } catch (e) {
    if (e.noBranch) return [400, { ok: false, error: 'no_branch', message: e.message }];
    return [500, { ok: false, error: 'git', message: 'Git could not read the branch of ' + top + ': ' + e.message }];
  }
  const unusable = tasks.baseProblem(base);
  if (unusable) return [400, { ok: false, error: 'bad_base', message: unusable }];
  let repo;
  try { repo = await tasks.mainCheckout(top); } catch (e) { return [500, { ok: false, error: 'git', message: 'Git could not find the main checkout of ' + top + ': ' + e.message }]; }
  return [null, { top, base, repo }];
}

async function askPm(channel, body, ctx) {
  const idea = clean(body.idea).replace(/\s+/g, ' ');
  if (!idea) return [400, { ok: false, error: 'bad_idea', message: 'Tell the PM what the idea is.' }];
  if (idea.length > MAX_BODY) return [400, { ok: false, error: 'bad_idea', message: 'Keep the idea to ' + MAX_BODY + ' characters.' }];
  const [bad, ground] = await pmGround(terminal.expand(body.repo));
  if (bad) return [bad, ground];
  const { top, base, repo } = ground;
  const [status, started] = await checkouts.forPm(channel, { top, base, title: 'PM: ' + idea.slice(0, 70), cols: body.cols, rows: body.rows }, ctx);
  if (status >= 400) return [status, started];
  delivery.promptOnce(channel, started.id, pmBrief({ idea, mayOrder: trust.may(trust.ORDER), notes: pmNotes.brief(repo), cli: CLI, skills: require('./skills.js').brief('pm') + require('./rules.js').brief() }), (problem) => { if (problem) ctx.log('The PM was not briefed: ' + problem); });
  return [201, { ok: true, terminal: started.id }];
}

async function seatPm(channel, from, ctx) {
  const [bad, ground] = await pmGround(from);
  let status, started, notes = '';
  if (bad) {
    ctx.log('The PM reads ' + from + ' itself, with no checkout of its own: ' + ground.message);
    const r = terminal.start(channel, { cwd: from, title: 'PM', role: 'pm' }, ctx, undefined, { standing: true });
    [status, started] = [r.status, r.body];
  } else {
    [status, started] = await checkouts.forPm(channel, { top: ground.top, base: ground.base, title: 'PM', standing: true }, ctx);
    notes = pmNotes.brief(ground.repo);
  }
  if (status >= 400) return [status, started];
  delivery.promptOnce(channel, started.id, standingBrief({ mayOrder: trust.may(trust.ORDER), notes, cli: CLI, skills: require('./skills.js').brief('pm') + require('./rules.js').brief() }), (problem) => { if (problem) ctx.log('The PM was not briefed: ' + problem); });
  return [201, { ok: true, terminal: started.id }];
}

function approveReady(channel, body) {
  const ids = body && body.ids;
  if (ids !== undefined && (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string'))) return [400, { ok: false, error: 'bad_param', message: '"ids" is a list of ticket ids.' }];
  return inTurn(channel, async () => {
    const all = await store.list(channel), approved = [];
    const wanted = (t) => t.status === 'ready' && !personApproved(t) && !starting.has(channel + '/' + t.id) && (!ids || ids.includes(t.id));
    for (const t of all.filter(wanted)) { await store.update(channel, t.id, { approvedBy: 'you' }, { person: true }); history.add(channel, t, { stage: 'approved', by: 'you' }); approved.push(t.id); }
    return [200, { ok: true, approved }];
  });
}

async function board(channel) {
  const all = await listAll(channel), needs = needsYouOf(channel);
  const lead = terminal.leadOf(channel);
  return { ok: true, store: store.name, wipLimit: tasks.wipLimit(), leadStarts: lead ? lead.starts || 0 : 0, leadStartsLeft: lead ? lead.startsLeft || 0 : 0, statuses: STATUSES, kinds: kindsOf(all), labels: labelsOf(all), tickets: await Promise.all(boardOrder(all).map((t) => view(channel, t, all, needs))) };
}
const changeWatchers = [];
const onChange = (fn) => changeWatchers.push(fn);
const filedWatchers = [];
const onFiled = (fn) => filedWatchers.push(fn);
const filed = (channel, ticket, agent, at) => filedWatchers.forEach((fn) => { try { fn(channel, ticket, agent || null, at); } catch (e) { console.error('A watcher of filed tickets failed: ' + e.message); } });
const changed = (channel) => changeWatchers.forEach((fn) => fn(channel));

const EDITABLE = ['title', 'body', 'priority', 'kind', 'labels', 'mark', 'replacedBy', 'shapes', 'base'];
const PERSON_ONLY = ['kind', 'labels', 'mark', 'replacedBy', 'shapes', 'base'];
async function edit(channel, ticket, body, agent) {
  const asked = EDITABLE.filter((k) => body[k] !== undefined);
  if (!asked.length) return [400, { ok: false, error: 'bad_param', message: 'Give at least one of ' + EDITABLE.map((k) => '"' + k + '"').join(', ') + '.' }];
  const theirs = agent ? asked.filter((k) => PERSON_ONLY.includes(k)) : [];
  if (theirs.length) return [403, { ok: false, error: 'forbidden', message: 'Only the person changes a ticket\'s ' + theirs.join(', ') + '. A PM or Lead edits its title, body and priority.' }];
  if (agent && body.priority !== undefined) { const off = orderOff(channel, agent, ticket.id); if (off) return off; }
  if (body.replacedBy !== undefined && body.mark === undefined) return [400, { ok: false, error: 'bad_mark', message: 'Send "replacedBy" with "mark": "replaced".' }];
  const want = {};
  if (body.title !== undefined) {
    want.title = clean(body.title).replace(/\s+/g, ' ');
    if (!want.title) return [400, { ok: false, error: 'bad_title', message: 'A ticket needs a title.' }];
    if (want.title.length > MAX_TITLE) return [400, { ok: false, error: 'bad_title', message: 'Keep the title to ' + MAX_TITLE + ' characters.' }];
  }
  if (body.body !== undefined) {
    want.body = clean(body.body);
    if (want.body.length > MAX_BODY) return [400, { ok: false, error: 'bad_body', message: 'Keep the body to ' + MAX_BODY + ' characters.' }];
  }
  if (body.priority !== undefined) {
    want.priority = String(body.priority);
    if (!PRIORITIES.includes(want.priority)) return [400, { ok: false, error: 'bad_priority', message: 'Priority is one of: ' + PRIORITIES.join(', ') + '.' }];
  }
  if (body.mark !== undefined) {
    want.mark = body.mark === null || body.mark === '' ? null : String(body.mark);
    if (want.mark !== null && !MARKS.includes(want.mark)) return [400, { ok: false, error: 'bad_mark', message: 'A mark is ' + MARKS.join(' or ') + ', or null to clear it.' }];
    want.replacedBy = want.mark === 'replaced' && body.replacedBy ? clean(body.replacedBy) : null;
  }
  if (body.base !== undefined) {
    want.base = clean(body.base);
    if (!want.base) return [400, { ok: false, error: 'bad_base', message: 'Name the branch to start from.' }];
    const unusable = tasks.baseProblem(want.base);
    if (unusable) return [400, { ok: false, error: 'bad_base', message: unusable }];
    if (!(await tasks.hasBranch(ticket.repo, want.base))) return [400, { ok: false, error: 'no_base', message: 'There is no local branch ' + want.base + ' with any commits in ' + ticket.repo + '.' }];
  }
  return inTurn(channel, async () => {
    const all = await listAll(channel);
    const now = all.find((t) => t.id === ticket.id) || ticket;
    const state = starting.has(channel + '/' + now.id) ? 'starting' : now.status;
    const open = ORDERABLE.includes(state);
    if ((body.title !== undefined || body.body !== undefined) && !open) return [agent ? 403 : 409, { ok: false, error: 'not_ready', message: 'Only a ticket in Triage or Ready can be edited. This one is ' + state + '.' }];
    if (body.priority !== undefined && !open) return notReady(agent, 'priority', state);
    if (body.kind !== undefined && !open) return notReady(agent, 'kind', state);
    if (body.base !== undefined && !open) return notReady(agent, 'base', state);
    if (want.mark && !open) return [409, { ok: false, error: 'not_ready', message: 'Only a ticket in Triage or Ready can be marked. This one is ' + state + '.' }];
    if (body.shapes !== undefined && !['triage', 'ready', 'started'].includes(now.status)) return [409, { ok: false, error: 'not_ready', message: 'Only a ticket in Triage, Ready or Started can change what it shapes. This one is ' + now.status + '.' }];
    if (body.kind !== undefined) { const r = kindFrom(body.kind, all, null); if (r.error) return r.error; want.kind = r.kind; }
    if (body.labels !== undefined) { const r = labelsFrom(body.labels, all, null); if (r.error) return r.error; want.labels = r.labels; }
    if (body.shapes !== undefined) { const r = shapesFrom(body.shapes, all, now.id); if (r.error) return r.error; want.shapes = r.shapes; }
    if (want.replacedBy && (want.replacedBy === now.id || !all.some((t) => t.id === want.replacedBy))) return [400, { ok: false, error: 'bad_mark', message: want.replacedBy === now.id ? 'A ticket cannot replace itself.' : 'No such ticket: ' + want.replacedBy + '.' }];
    const kindNow = want.kind !== undefined ? want.kind : now.kind;
    if (kindNow === JAM) {
      if (want.priority !== undefined && want.priority !== 'high') return [409, { ok: false, error: 'jam_priority', message: 'A jam ticket stays high priority: stuck work holds other PRs. Close it, or leave its priority.' }];
      if (want.priority === undefined && want.kind === JAM && now.kind !== JAM && (now.priority || 'normal') !== 'high') want.priority = 'high';
    }
    const had = (k) => (k === 'priority' ? (now.priority || 'normal') : k === 'labels' || k === 'shapes' ? (Array.isArray(now[k]) ? now[k] : []).join(',') : k === 'mark' || k === 'replacedBy' || k === 'kind' ? (now[k] || null) : (now[k] || ''));
    const what = Object.keys(want).filter((k) => had(k) !== (Array.isArray(want[k]) ? want[k].join(',') : want[k]));
    if (!what.length) return [200, { ok: true, unchanged: true, edited: [], ticket: await view(channel, now, all) }];
    const title = want.title !== undefined ? want.title : now.title, base = want.base !== undefined ? want.base : now.base;
    if (what.includes('title') || what.includes('base')) {
      const twin = all.find((t) => t.id !== now.id && t.status !== 'done' && (agent || t.status !== 'rejected') && t.repo === now.repo && t.title.toLowerCase() === title.toLowerCase() && (!t.base || t.base === base));
      if (twin) return [409, { ok: false, error: 'duplicate', message: twin.id + ' already has that title' + (twin.base ? ' on ' + twin.base : ' in this repo') + (twin.status === 'rejected' ? ', and the person rejected it' : '') + (what.includes('title') ? '. Use another title, or that ticket.' : '. Use that ticket, or reject one of them.'), ticket: await view(channel, twin, all) }];
    }
    const changes = {};
    for (const k of what) changes[k] = want[k];
    if (what.includes('mark') || what.includes('replacedBy')) Object.assign(changes, { mark: want.mark, replacedBy: want.replacedBy });
    const others = all.filter((t) => t.id !== now.id);
    if (what.includes('priority')) Object.assign(changes, { rank: want.kind === JAM ? firstRank(others, want.priority, Date.now()) : lastRank(others, want.priority, Date.now()) }, setBy(agent, 'priority'));
    else if (what.includes('kind') && want.kind === JAM && (now.priority || 'normal') === 'high') changes.rank = firstRank(others, 'high', Date.now());
    const approvalTaken = !!agent && now.status === 'ready' && personApproved(now) && (what.includes('title') || what.includes('body'));
    if (approvalTaken) changes.approvedBy = 'none';
    const edited = await store.update(channel, now.id, changes);
    if (what.includes('title')) chat.openTicketRoom(channel, chatOf(edited));
    if (what.includes('kind')) filed(channel, edited, null, new Date().toISOString());
    if (what.some((k) => ['title', 'body', 'priority'].includes(k))) history.add(channel, now, { stage: 'edited', by: !agent ? 'you' : agent.lead ? 'Lead' : 'PM', what: what.filter((k) => ['title', 'body', 'priority'].includes(k)) }, agent || null);
    return [200, Object.assign({ ok: true, edited: what, ticket: await view(channel, edited, all.map((t) => (t.id === now.id ? edited : t))) }, approvalTaken ? { approvalTaken } : {})];
  });
}

async function handle(req, res, channel, rest, ctx) {
  const route = rest.match(/^\/tickets(?:\/(ask|approve-ready)|\/([\w-]{1,64})\/(move|start|order|edit|propose|proposal|note|advice)|\/([\w-]{1,64}))?$/);
  if (!route) { if (!/^\/tickets(\/|$)/.test(rest)) return false; ctx.problem(res, 404, 'not_found', 'Unknown ticket route.'); return true; }
  const deny = terminal.localOnly(req, ctx.port);
  if (deny) { ctx.problem(res, 403, 'local_only', deny); return true; }
  if (!terminal.ENABLED) { ctx.problem(res, 404, 'terminal_off', 'Tickets need the terminal. Start the relay with npm run office, or with RELAY_TERMINAL=1.'); return true; }
  const [, ask, actOn, verb, id] = route;
  const body = req.method === 'POST' ? await ctx.readJson(req) : null;
  let out;
  try {
    if (ask === 'approve-ready' && req.method === 'POST') {
      if (ctx.agent) { ctx.problem(res, 401, 'unauthorized', 'Only the person approves tickets.'); return true; }
      out = await approveReady(channel, body || {});
      if (out[1].ok && out[1].approved.length) ctx.log('Approved all Ready: ' + out[1].approved.join(', '));
    } else if (ask === 'ask' && req.method === 'POST') out = await askPm(channel, body, ctx);
    else if (!ask && !actOn && !id && req.method === 'GET') out = [200, await board(channel)]; else if (!ask && !actOn && !id && req.method === 'POST') out = await create(channel, body, ctx.agent);
    else if (actOn || id) {
      const ticket = await store.get(channel, actOn || id);
      if (!ticket) { ctx.problem(res, 404, 'no_ticket', 'No such ticket on this channel.'); return true; }
      if (id && req.method === 'GET') { const all = await listAll(channel); out = [200, { ok: true, ticket: await view(channel, all.find((t) => t.id === id), all) }]; }
      else if (req.method === 'POST' && verb === 'move') {
        const to = String((body && body.to) || ''), refused = ctx.agent && require('./autopilot.js').leadRefusal(channel, to, to === 'done' && require('./floor.js').merged(channel, clean(body.pr)));
        out = refused || await move(channel, ticket, body || {}, ctx.agent);
        if (ctx.agent && out[1].ok) ctx.log('The Lead moved ' + ticket.id + ' to ' + out[1].ticket.status + (out[1].ticket.status === 'done' && out[1].ticket.pr ? ' with ' + out[1].ticket.pr : ''));
      }
      else if (req.method === 'POST' && verb === 'start') {
        out = await start(channel, ticket, body || {}, ctx);
        if (ctx.agent && out[1].ok) {
          terminal.useStart(channel, ctx.agent, ticket);
          ctx.log('The Lead started ' + ticket.id + ' (task ' + out[1].task.id + '). ' + (ctx.agent.startsLeft ? ctx.agent.startsLeft + ' starts left.' : 'That was its last start, so it can no longer start tickets.'));
        }
      }
      else if (req.method === 'POST' && verb === 'edit') {
        out = await edit(channel, ticket, body || {}, ctx.agent);
        if (ctx.agent && out[1].ok && !out[1].unchanged) ctx.log('The ' + (ctx.agent.lead ? 'Lead' : 'PM') + ' edited ' + ticket.id + ': ' + out[1].edited.join(', ') + (out[1].approvalTaken ? '. It needs your approval again.' : ''));
      }
      else if (req.method === 'POST' && verb === 'note') {
        out = await addNote(channel, ticket, body || {}, ctx.agent);
        if (ctx.agent && out[1].ok) ctx.log(noteBy(ctx.agent) + ' added a note to ' + ticket.id);
      }
      else if (req.method === 'POST' && verb === 'propose') {
        out = await propose(channel, ticket, body || {}, ctx.agent);
        if (ctx.agent && out[1].ok) ctx.log(out[1].message);
        if (ctx.agent && ctx.agent.lead && out[1].ok && await leadMergesTwin(channel, ticket, body || {})) out = await carryOut(channel, ticket);
      }
      else if (req.method === 'POST' && verb === 'advice') {
        out = await advise(channel, ticket, body || {}, ctx.agent);
        if (ctx.agent && out[1].ok) ctx.log('The PM advised ' + ticket.id + ': ' + out[1].answer + '. ' + out[1].message);
      }
      else if (req.method === 'POST' && verb === 'proposal') {
        if (ctx.agent) { ctx.problem(res, 401, 'unauthorized', 'Only the person approves or declines a proposal.'); return true; }
        out = await decide(channel, ticket, body || {});
      }
      else if (req.method === 'POST' && verb === 'order') {
        const refused = ctx.agent && sessionMayOrder(channel, ctx.agent, ticket.id);
        if (refused) { ctx.problem(res, 403, 'forbidden', refused); return true; }
        out = await setPlace(channel, ticket, body || {}, ctx.agent);
        if (ctx.agent && out[1].ok) ctx.log('The ' + (ctx.agent.lead ? 'Lead' : 'PM') + ' set the place of ' + ticket.id);
      }
    }
  } catch (e) {
    ctx.log('Ticket store (' + store.name + '): ' + (e && e.message));
    if (e && e.refused) ctx.problem(res, 409, 'store_refused', e.message); else ctx.problem(res, 502, 'store', 'The ticket store did not answer: ' + (e && e.message));
    return true;
  }
  if (!out) { ctx.problem(res, 404, 'not_found', 'Unknown ticket route.'); return true; }
  if (req.method === 'POST' && out[1].ok) changed(channel);
  ctx.send(res, out[0], out[1]);
  return true;
}

const startingNow = (channel) => leadStarting.has(channel) || [...starting].some((k) => k.startsWith(channel + '/'));
const startBy = (channel, ticket, by, ctx) => startTicket(channel, ticket, {}, ctx, null, by);

module.exports = { closeForFailure, seatPm, handle, fileAsManager, noteAsManager, listAll, writeErrors, unreadNotes, board, onChange, onFiled, startBy, startingNow, holdStarts, heldWhy, CLI, KINDS, MAX_LABELS };
