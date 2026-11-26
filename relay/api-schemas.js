// The shapes of the relay's core resources and requests, as JSON Schema: tickets, tasks, sessions, the
// Floor, commands, events and a reviewer's verdict. relay/server.js checks the JSON types of a request
// to a route in REQUESTS before the route reads it, and answers 400 with bad_type when one is wrong. Each
// route still checks the values itself, with its own error codes. relay/openapi.js puts these schemas in
// docs/openapi.json, and relay/test/openapi.test.js checks real answers against RESPONSES and that each
// route refuses a request that breaks its schema. Each request schema has an example, which the test
// checks against the schema. Keys are a method and a path under /channels/{channel}.
'use strict';

const S = (extra) => Object.assign({ type: 'string' }, extra);
const N = (extra) => Object.assign({ type: 'number' }, extra);
const B = { type: 'boolean' };
const orNull = (schema) => Object.assign({}, schema, { type: [].concat(schema.type, 'null') });
const list = (items) => ({ type: 'array', items });
const obj = (properties, required, extra) => Object.assign({ type: 'object', properties, required: required || [], additionalProperties: true }, extra);
const ref = (name) => ({ $ref: '#/components/schemas/' + name });
const okWith = (properties, required) => obj(Object.assign({ ok: { const: true } }, properties), ['ok'].concat(required || []));

const PRIORITIES = ['high', 'normal', 'low'];
const STATUSES = ['triage', 'ready', 'started', 'done', 'rejected'];
const STATES = ['building', 'in_review', 'changes_requested', 'waiting_on_you', 'done'];
const WORD = '^[a-z][a-z0-9-]{0,23}$';

const SCHEMAS = {
  Ok: okWith({}),
  Problem: obj({ ok: { const: false }, error: S({ description: 'A short code, such as bad_param, forbidden or not_found.' }), message: S({ description: 'What went wrong, in plain words.' }) }, ['ok', 'error', 'message']),
  TicketStep: obj({ at: S(), stage: S(), by: S() }, ['at', 'stage', 'by'], { description: 'One step in a ticket\'s history.' }),
  TicketNote: obj({ by: S({ description: 'Who wrote it, as the relay named them.' }), role: orNull(S({ description: 'dev, reviewer, pm, lead or null for the person.' })), at: S(), text: S({ maxLength: 2000 }) }, ['by', 'at', 'text'], { description: 'A note a session added to a ticket. It is not part of the ticket\'s body.' }),
  Ticket: obj({
    id: S({ description: 'Such as T-5, or the issue number in the GitHub store.' }),
    title: S({ maxLength: 80 }),
    body: S({ maxLength: 8000 }),
    status: S({ enum: STATUSES }),
    priority: S({ enum: PRIORITIES }),
    rank: N({ description: 'Its place in the work order within its priority.' }),
    repo: orNull(S()),
    base: orNull(S({ description: 'The branch a start makes its branch from.' })),
    kind: orNull(S({ pattern: WORD })),
    labels: list(S({ pattern: WORD })),
    blockedBy: list(S()),
    waitingFor: list(S()),
    rejectedBlockers: list(S()),
    approved: B,
    approvedBy: orNull(S()),
    createdBy: orNull(S()),
    heldBack: orNull(S({ description: 'Why nothing starts it by itself: a hold, a replacement, a design ticket or a proposal.' })),
    mark: orNull(S({ enum: ['hold', 'replaced'] })),
    task: { type: ['object', 'null'], description: 'Its task once started.' },
    history: list(ref('TicketStep')),
    notes: list(ref('TicketNote')),
    createdAt: S(),
    updatedAt: S()
  }, ['id', 'title', 'status', 'priority', 'createdAt', 'updatedAt']),
  TicketList: okWith({ store: S(), wipLimit: N(), leadStarts: N(), leadStartsLeft: N(), statuses: list(S({ enum: STATUSES })), kinds: list(S()), labels: list(S()), tickets: list(ref('Ticket')) }, ['tickets', 'statuses', 'kinds', 'labels']),
  TicketOne: okWith({ ticket: ref('Ticket') }, ['ticket']),
  NewTicket: obj({
    title: S({ minLength: 1, maxLength: 80 }),
    body: S({ maxLength: 8000 }),
    priority: S({ enum: PRIORITIES }),
    repo: S({ description: 'The folder of the repo. A session files in its own folder, and this is ignored.' }),
    kind: orNull(S({ pattern: WORD })),
    labels: { type: ['array', 'string'], items: S({ pattern: WORD }), description: 'A list, or one string with commas between.' },
    blockedBy: list(S()),
    shapes: list({ type: ['string', 'number'] })
  }, ['title'], { examples: [{ title: 'Flaky test in tasks.test.js', body: 'It fails about one run in ten on CI.', priority: 'normal', kind: 'bug', labels: ['flaky'] }] }),
  NewTicketNote: obj({ text: S({ minLength: 1, maxLength: 2000 }) }, ['text'], { examples: [{ text: 'The cause is in relay/tickets.js, not relay/tasks.js. Run npm test first.' }] }),
  TicketEdit: obj({
    title: S({ minLength: 1, maxLength: 80 }),
    body: S({ maxLength: 8000 }),
    priority: S({ enum: PRIORITIES, description: 'A PM or the Lead needs its switch on to send this.' }),
    kind: orNull(S({ pattern: WORD, description: 'The person only.' })),
    labels: { type: ['array', 'string'], items: S({ pattern: WORD }), description: 'The person only. A list, or one string with commas between.' },
    mark: orNull(S({ enum: ['hold', 'replaced', ''], description: 'The person only. null or an empty string clears it.' })),
    replacedBy: S({ description: 'With "mark": "replaced": the ticket that replaces it.' }),
    shapes: list({ type: ['string', 'number'] }),
    base: S({ minLength: 1, description: 'The person only. A local branch with commits.' })
  }, [], { minProperties: 1, description: 'Any of these, saved together, or none when one is refused. A PM or the Lead sends only title, body and priority.', examples: [{ title: 'Flaky test in tasks.test.js on CI', priority: 'high' }] }),
  Task: obj({
    id: S({ pattern: '^[0-9a-f]{6}$' }),
    title: S(),
    state: S({ enum: STATES }),
    branch: orNull(S()),
    pr: orNull(S()),
    ticket: orNull(S()),
    repo: S(),
    base: orNull(S()),
    worktree: orNull(S()),
    briefed: B,
    owner: { type: ['object', 'null'] },
    worker: { type: ['object', 'null'] },
    history: list(obj({ at: S(), type: S() }, ['at'])),
    createdAt: S(),
    updatedAt: S()
  }, ['id', 'title', 'state'], { description: 'A session\'s token gets only id, state, title, branch and pr.' }),
  TaskList: okWith({ states: list(S({ enum: STATES })), tasks: list(ref('Task')) }, ['tasks']),
  TaskOne: okWith({ task: ref('Task') }, ['task']),
  NewTask: obj({ title: S({ minLength: 1, maxLength: 80 }), repo: S(), brief: S(), base: S(), lead: B }, ['title'], { examples: [{ title: 'Fix the flaky test in tasks.test.js', brief: 'Find why it fails about one run in ten on CI, and fix it.' }] }),
  TaskMove: obj({ to: S({ enum: STATES }), note: S(), pr: S() }, ['to'], { examples: [{ to: 'in_review', note: 'The PR is open for review.' }] }),
  Session: obj({
    id: S({ pattern: '^[0-9a-f]{12}$' }),
    who: orNull(S()),
    cwd: S(),
    sessionId: S(),
    title: orNull(S()),
    role: orNull(S()),
    task: orNull(S()),
    pr: orNull(S()),
    lead: B,
    running: B,
    state: S({ description: 'working, waiting, idle, quiet or stuck, from its hooks.' }),
    startedAt: S()
  }, ['id', 'cwd', 'sessionId', 'lead', 'running', 'state']),
  SessionList: okWith({ enabled: B, home: S(), cwd: S(), terminals: list(ref('Session')), lead: { type: ['object', 'null'] }, wipLimit: N() }, ['enabled', 'terminals']),
  FloorRow: obj({
    terminal: S(),
    name: S(),
    role: S(),
    ticket: orNull(S()),
    title: orNull(S()),
    pr: orNull(S()),
    state: S(),
    safe: B,
    canStop: B,
    why: S(),
    seat: orNull(S({ description: 'lead for the Lead, pm for the PM the room keeps running, or null.' })),
    stuckJobs: list(obj({ pid: N(), command: S(), minutes: N() }, ['pid', 'command', 'minutes'])),
    desk: { type: 'object' }
  }, ['terminal', 'name', 'role', 'state', 'safe', 'canStop', 'why']),
  EndedJob: okWith({ ended: obj({ name: S(), terminal: S(), pid: N() }, ['name', 'terminal', 'pid']) }, ['ended']),
  Floor: okWith({ sessions: list(ref('FloorRow')), pm: obj({ trust: N(), trustName: S(), sortHours: N(), nextSortAt: orNull(S()) }), leadEnded: { type: ['object', 'null'] }, mainRed: list(obj({ branch: S(), repo: S(), says: S() })) }, ['sessions']),
  NewJam: obj({
    kind: S({ enum: Object.keys(require('./metrics-plan.js').JAM_KINDS) }),
    ticket: S({ maxLength: 300, description: 'Optional: the ticket, such as T-5.' }),
    pr: S({ maxLength: 300, description: 'Optional: the PR\'s address.' }),
    since: S({ maxLength: 40, description: 'Optional: when it got stuck, an ISO time.' }),
    fix: S({ minLength: 1, maxLength: 200, description: 'One line: what fixed it.' }),
    by: S({ maxLength: 40, description: 'Optional: who fixed it. you by default. The Lead\'s token always writes Lead.' }),
    outcome: S({ enum: ['fixed', 'passed', 'seen'], description: 'Optional: fixed by default.' }),
    blocked: N({ description: 'Optional: how many PRs a shared failure channel blocked.' })
  }, ['kind', 'fix'], { examples: [{ kind: 'no-first-review', ticket: 'T-5', since: '2026-11-24T10:00:00.000Z', fix: 'Pressed Get a review.', by: 'you' }] }),
  Jam: obj({ at: S(), kind: S(), ticket: orNull(S()), pr: orNull(S()), since: orNull(S()), fix: S(), by: S(), outcome: S({ enum: ['fixed', 'passed', 'seen'] }), blocked: N() }, ['at', 'kind', 'fix', 'by']),
  JamOne: okWith({ jam: ref('Jam') }, ['jam']),
  JamList: okWith({ range: S({ enum: ['1d', '7d', '30d'] }), keptDays: N(), kinds: { type: 'object' }, jams: list(ref('Jam')) }, ['range', 'jams']),
  Metrics: okWith({
    at: S(), range: S({ enum: ['1d', '7d', '30d'] }), days: N(), since: S(), keptDays: N(), bucketMinutes: N(),
    numbers: obj({ merged: N(), medianMinutes: orNull(N()), waitingOnYouHours: N(), stalledHours: N(), noHelpShare: orNull(N()), jamsFixedByHand: N() }, ['merged', 'waitingOnYouHours', 'stalledHours', 'jamsFixedByHand']),
    merged: obj({ days: list(obj({ day: S(), autopilot: N(), person: N() }, ['day', 'autopilot', 'person'])) }, ['days']),
    perTicket: obj({ parts: { type: 'object' }, medianMinutes: orNull(N()), tickets: list(obj({ ticket: orNull(S()), mergedAt: S(), minutes: N(), parts: { type: 'object' } }, ['mergedAt', 'minutes', 'parts'])) }, ['tickets']),
    where: obj({ parts: { type: 'object' }, minutes: { type: 'object' } }, ['minutes']),
    outcomes: obj({ counts: { type: 'object' }, reasons: { type: 'object' } }, ['counts', 'reasons']),
    stalls: obj({ kinds: list(obj({ kind: S(), label: S(), count: N(), hours: N(), detected: obj({ count: N(), hours: N() }, ['count', 'hours']), hand: obj({ count: N(), hours: N() }, ['count', 'hours']) }, ['kind', 'count', 'hours', 'detected', 'hand'])) }, ['kinds']),
    waits: obj({ reasons: { type: 'object' }, days: list({ type: 'object' }), items: list(obj({ at: S(), minutes: N(), reason: S() }, ['at', 'minutes', 'reason'])) }, ['days', 'items']),
    rounds: obj({ prs: list(obj({ rounds: S(), count: N() }, ['rounds', 'count'])) }, ['prs']),
    desks: obj({ points: list(obj({ at: S(), working: N(), idle: N(), waiting: N(), stuck: N(), free: N() }, ['at'])) }, ['points']),
    load: obj({ points: list(obj({ at: S(), cpu: N(), memoryMb: N(), limitMb: N() }, ['at'])) }, ['points']),
    lead: obj({
      available: B,
      timeToAct: obj({ count: N(), medianMinutes: orNull(N()), slowest: list(obj({ ticket: orNull(S()), pr: orNull(S()), kind: S(), minutes: N() }, ['kind', 'minutes'])) }, ['count', 'slowest']),
      fixed: obj({ total: N(), kinds: list(obj({ kind: S(), label: S(), count: N() }, ['kind', 'count'])) }, ['total', 'kinds']),
      passed: obj({ total: N(), kinds: list(obj({ kind: S(), label: S(), count: N() }, ['kind', 'count'])) }, ['total', 'kinds']),
      neverActed: obj({ total: N(), kinds: list(obj({ kind: S(), label: S(), count: N() }, ['kind', 'count'])) }, ['total', 'kinds']),
      failures: obj({ channels: N(), prsBlocked: N(), medianHours: orNull(N()) }, ['channels', 'prsBlocked'])
    }, ['available', 'timeToAct', 'fixed', 'passed', 'neverActed', 'failures']),
    pm: obj({ available: B, days: list({ type: 'object' }) }, ['available', 'days'])
  }, ['range', 'numbers', 'merged', 'perTicket', 'where', 'outcomes', 'stalls', 'waits', 'rounds', 'desks', 'load', 'lead', 'pm']),
  Command: obj({
    action: S({ minLength: 1, description: 'A command of the world, such as say or idle. GET /channels/{channel} lists them as unknown_action does.' }),
    wait: { type: ['boolean', 'string'], description: 'false sends it and answers at once with its id.' },
    timeout: { type: ['number', 'string'], description: 'Seconds to wait, 1 to 120, 30 by default.' },
    source: S()
  }, ['action'], { description: 'The command, with the fields its action takes.', examples: [{ action: 'say', who: 'marcus', text: 'Hello' }] }),
  CommandResult: obj({ id: S(), channel: S(), action: S(), status: S({ enum: ['pending', 'done'] }), ok: B }, ['id']),
  Event: obj({ rseq: N({ description: 'The relay\'s number for it, for ?since=.' }), receivedAt: S(), type: S() }, ['rseq', 'type']),
  EventList: okWith({ channel: S(), events: list(ref('Event')), lastEventSeq: N() }, ['events', 'lastEventSeq']),
  Verdict: obj({ kind: S({ enum: ['merge', 'fix'] }) }, ['kind'], { examples: [{ kind: 'merge' }] })
};

const REQUESTS = {
  'POST /tickets': 'NewTicket',
  'POST /tickets/{id}/edit': 'TicketEdit',
  'POST /tickets/{id}/note': 'NewTicketNote',
  'POST /tasks': 'NewTask',
  'POST /tasks/{id}/move': 'TaskMove',
  'POST /commands': 'Command',
  'POST /autopilot/verdict': 'Verdict',
  'POST /jams': 'NewJam'
};
const RESPONSES = {
  'GET /tickets': 'TicketList',
  'POST /tickets': 'TicketOne',
  'GET /tickets/{id}': 'TicketOne',
  'POST /tickets/{id}/edit': 'TicketOne',
  'POST /tickets/{id}/note': 'TicketOne',
  'GET /tasks': 'TaskList',
  'POST /tasks': 'TaskOne',
  'GET /tasks/{id}': 'TaskOne',
  'POST /tasks/{id}/move': 'TaskOne',
  'GET /terminals': 'SessionList',
  'GET /floor': 'Floor',
  'POST /floor/end-job': 'EndedJob',
  'GET /metrics': 'Metrics',
  'POST /jams': 'JamOne',
  'GET /jams': 'JamList',
  'GET /events': 'EventList',
  'GET /commands/{id}': 'CommandResult'
};

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const fits = (types, v) => [].concat(types).some((t) => t === typeOf(v) || (t === 'number' && typeOf(v) === 'integer'));
const named = (at) => (at ? '"' + at + '"' : 'The body');

function check(schema, value, options, at) {
  const opts = options || {}, s = schema.$ref ? SCHEMAS[schema.$ref.split('/').pop()] : schema, out = [];
  if (s.type && !fits(s.type, value)) return [named(at) + ' is ' + [].concat(s.type).join(' or ') + ', not ' + typeOf(value) + '.'];
  if (!opts.typesOnly) {
    if ('const' in s && value !== s.const) out.push(named(at) + ' is ' + JSON.stringify(s.const) + '.');
    if (s.enum && !s.enum.includes(value)) out.push(named(at) + ' is one of ' + s.enum.map((x) => JSON.stringify(x)).join(', ') + '.');
    if (typeof value === 'string' && s.minLength !== undefined && value.length < s.minLength) out.push(named(at) + ' is empty.');
    if (typeof value === 'string' && s.maxLength !== undefined && value.length > s.maxLength) out.push(named(at) + ' is longer than ' + s.maxLength + ' characters.');
    if (typeof value === 'string' && s.pattern && !new RegExp(s.pattern).test(value)) out.push(named(at) + ' does not match ' + s.pattern + '.');
  }
  if (typeOf(value) === 'object') {
    if (!opts.typesOnly) {
      for (const k of s.required || []) if (value[k] === undefined) out.push('"' + (at ? at + '.' : '') + k + '" is missing.');
      if (s.minProperties && Object.keys(value).length < s.minProperties) out.push(named(at) + ' needs at least ' + s.minProperties + ' field.');
    }
    for (const [k, sub] of Object.entries(s.properties || {})) if (value[k] !== undefined) out.push(...check(sub, value[k], opts, (at ? at + '.' : '') + k));
  }
  if (Array.isArray(value) && s.items) value.forEach((x, i) => out.push(...check(s.items, x, opts, (at || 'item') + '[' + i + ']')));
  return out;
}

const TEMPLATE = (key) => { const [method, p] = key.split(' '); return { method, re: new RegExp('^' + p.replace(/\{\w+\}/g, '[^/]+') + '$') }; };
const MATCHERS = Object.entries(REQUESTS).map(([key, name]) => Object.assign(TEMPLATE(key), { key, name }));
function requestSchema(method, rest) {
  const m = MATCHERS.find((x) => x.method === method && x.re.test(rest));
  return m ? { key: m.key, name: m.name, schema: SCHEMAS[m.name] } : null;
}

module.exports = { SCHEMAS, REQUESTS, RESPONSES, check, requestSchema, ref };
