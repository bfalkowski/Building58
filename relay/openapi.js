// Builds docs/openapi.json, the relay's API as an OpenAPI 3.1 document, from the route tables in
// docs/manual/relay.html, so the manual stays the one place the routes are described. The version is
// the one the page gives in <code id="api-version">. npm run openapi writes the file, and
// relay/test/openapi.test.js checks that the file is what this builds, that each route in it answers,
// and that a change since main came with a new version (docs/constitution.md, article 15).
// Each operation's tag comes from the first part of its path, and TAGS gives each one the name and
// line the docs show, so a new group of routes needs its own entry there.
//   node relay/openapi.js           writes docs/openapi.json
//   node relay/openapi.js --check   exits 1 if docs/openapi.json is out of date
'use strict';
const fs = require('fs');
const path = require('path');
const { SCHEMAS, REQUESTS, RESPONSES, ref } = require('./api-schemas.js');
const { tokenReaches } = require('./token-routes.js');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'docs', 'manual', 'relay.html');
const OUT = path.join(ROOT, 'docs', 'openapi.json');
const MANUAL = 'docs/manual/relay.html';

const PARAMS = {
  channel: { pattern: '^[\\w-]{1,64}$', description: 'The channel, such as office: 1 to 64 letters, numbers, dashes or underscores.' },
  page: { pattern: '^\\d+$', description: 'The page\'s id, from the stream.' },
  'commands/id': { pattern: '^[0-9a-f-]{36}$', description: 'The command\'s id, from the reply to a command sent with wait: false.' },
  'tickets/id': { pattern: '^[\\w-]{1,64}$', description: 'The ticket\'s id, such as T-5.' },
  'rules/id': { pattern: '^[\\w-]{1,64}$', description: 'The standing rule\'s id, such as R-1a2b3c.' },
  'tasks/id': { pattern: '^[0-9a-f]{6}$', description: 'The task\'s id.' },
  'checkouts/id': { pattern: '^[0-9a-f]{6}$', description: 'The checkout\'s id.' },
  'terminals/id': { pattern: '^[0-9a-f]{12}$', description: 'The session\'s id on the relay.' },
  'rounds/id': { pattern: '^[0-9a-f]{8}$', description: 'The round\'s id.' },
  seat: { pattern: '^S\\d{1,2}$', description: 'The seat, such as S1.' },
  name: { pattern: '^[\\w-]{1,64}$', description: 'The chat channel\'s name.' },
  pid: { pattern: '^\\d+$', description: 'The old relay\'s process id.' },
  role: { pattern: '^(coo|security)$', description: 'The officer: coo or security.' }
};

const TAGS = {
  calls: ['Calls', 'Calls any caller uses: commands, events and the page.'],
  autopilot: ['Autopilot', 'Autopilot, which starts and merges work by itself, and the verdicts and fixes it asks for.'],
  chat: ['Chat', 'The chat channels: #office, one for each ticket, and fun ones.'],
  checkouts: ['Checkouts', 'Sessions that start in a new checkout of their own, and cleaning a checkout up.'],
  failures: ['Failures', 'The shared channel for a failure that blocks two or more PRs, and the Lead\'s rerun and stuck items.'],
  floor: ['Floor', 'What the Lead sees of each session at work, and the Lead stopping one.'],
  games: ['Games', 'The games there are, their rounds, and each seat\'s actions.'],
  huddle: ['Huddle', 'A question to the idle sessions, and the report of their answers.'],
  manager: ['Manager watch', 'What the manager notices about stuck work, and the limits he uses.'],
  jams: ['Jams', 'The jam log: stalls the person fixed by hand, which the Metrics page counts.'],
  metrics: ['Metrics', 'The numbers behind the Metrics page: how the room works over time.'],
  'needs-you': ['Needs you', 'The things that wait on the person, most urgent first.'],
  officers: ['Officers', 'The COO and the security officer: their reports, and what they write from.'],
  'old-relays': ['Old relays', 'Other relays that still run on this room\'s state folder, and stopping one.'],
  'pr-watch': ['PR watch', 'The PR watch, and each task with an open PR that it looks at.'],
  ready: ['Ready to merge', 'Marking a PR ready to merge.'],
  reviews: ['Reviews', 'The automatic reviews of PRs.'],
  rules: ['Standing rules', 'The rules the person sets for a while, which each new brief carries while they are in force.'],
  settings: ['Settings', 'The settings on the room page.'],
  tasks: ['Tasks', 'The work a session does on its own branch, from the start to the merge.'],
  terminals: ['Sessions', 'The Claude Code sessions the relay runs: start, list, watch, type into, resize and stop them, and which one is the Lead.'],
  tickets: ['Tickets', 'The Board: file, edit, move, order, approve and start tickets, and proposals and questions about them.'],
  update: ['Update', 'Updating the relay\'s own folder, and rolling a bad update back.']
};
const SEGMENT_TAG = { rounds: 'games', play: 'games', rerun: 'failures', stuck: 'failures' };
function tagOf(r) {
  const part = r.section === 'calls' ? 'calls' : r.path.split('/')[3];
  const key = SEGMENT_TAG[part] || part;
  if (!TAGS[key]) throw new Error('No tag for ' + r.method + ' ' + r.path + '. Add "' + key + '" to TAGS in relay/openapi.js.');
  return TAGS[key][0];
}

const text = (h) => h.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

function rows(html) {
  const out = [];
  for (const id of ['calls', 'routes']) {
    const start = html.indexOf('<h2 id="' + id + '">');
    const body = html.slice(start, html.indexOf('</table>', start));
    for (const m of body.matchAll(/<tr><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/g)) {
      const head = text(m[2]), words = head.match(/^((?:GET|POST)(?:, (?:GET|POST))*) (\S.*)$/);
      if (!words) continue;
      const methods = words[1].split(', ');
      const [first, ...more] = words[2].split(', ');
      const stem = first.slice(0, first.lastIndexOf('/'));
      const paths = [first, ...more.map((p) => stem + p)].map((p) => p.replace(/<(\w+)>/g, '{$1}'));
      const names = text(m[1]).split(', '), ops = paths.flatMap((p) => methods.map((method) => ({ method, p })));
      if (names.length !== ops.length) throw new Error(head + ' in ' + MANUAL + ' has ' + names.length + ' names for ' + ops.length + ' operations.');
      ops.forEach(({ method, p }, i) => out.push({ section: id, name: names[i], method, path: id === 'routes' ? '/channels/{channel}' + p : p, about: text(m[3]) }));
    }
  }
  return out;
}

function paramOf(name, full) {
  const before = full.slice(0, full.indexOf('{' + name + '}')).split('/').filter(Boolean);
  const key = PARAMS[before[before.length - 1] + '/' + name] ? before[before.length - 1] + '/' + name : name;
  const p = PARAMS[key];
  if (!p) throw new Error('No pattern for {' + name + '} in ' + full + '. Add it to PARAMS in relay/openapi.js.');
  return { name, in: 'path', required: true, description: p.description, schema: { type: 'string', pattern: p.pattern } };
}

const ROLES = [
  ['any session', { role: null }], ['a PM', { role: 'pm' }], ['a reviewer', { role: 'reviewer', reviewOf: 'pr' }],
  ['the Lead', { lead: true }], ['a Lead you let move the board', { lead: true, board: true }], ['a Lead you let start tickets', { lead: true, starts: 1 }],
  ['the COO', { role: 'coo' }], ['the security officer', { role: 'security' }]
];
const SAMPLE = { channel: 'c', page: '1', name: 'general', seat: 'S1', pid: '1' };
const sample = (p) => p.replace(/\{(\w+)\}/g, (_, k) => (k === 'id' && /terminals\/\{id\}/.test(p) ? '000000000000' : k === 'id' && /tasks\/\{id\}|checkouts\/\{id\}/.test(p) ? '000000' : k === 'id' && /rounds\/\{id\}/.test(p) ? '00000000' : k === 'id' && /commands\/\{id\}/.test(p) ? '00000000-0000-0000-0000-000000000000' : k === 'id' ? 'T-1' : k === 'role' ? (p.includes('measures') || p.includes('report') ? null : 'coo') : SAMPLE[k]));
function tokensOf(r) {
  if (!r.path.startsWith('/channels/{channel}/')) return [];
  const rest = r.path.slice('/channels/{channel}'.length), out = [];
  for (const [who, agent] of ROLES) {
    const roles = rest.includes('{role}') ? ['coo', 'security'] : [null];
    if (roles.some((role) => tokenReaches(agent, r.method, (role ? rest.replace('{role}', role) : rest).replace(/\{\w+\}/g, (m) => sample(m)), false))) out.push(who);
  }
  if (tokenReaches({ role: null }, r.method, sample(rest), true)) out.push('a seat in a game round');
  const covered = (who) => (out.includes('any session') && ['a PM', 'a reviewer', 'the Lead', 'a Lead you let move the board', 'a Lead you let start tickets'].includes(who))
    || (out.includes('the Lead') && who.startsWith('a Lead you let'));
  return out.filter((who) => !covered(who));
}
const words = (name) => name.replace(/([A-Z])/g, ' $1').toLowerCase().replace(/^./, (c) => c.toUpperCase()).replace(/\bpm\b/i, 'PM');

function operation(r) {
  const key = r.method + ' ' + r.path.replace('/channels/{channel}', ''), stream = /\/stream$/.test(r.path), tokens = tokensOf(r);
  const success = stream ? { description: 'A stream of server-sent events, open until either side closes it.', content: { 'text/event-stream': { schema: { type: 'string' } } } }
    : { description: 'Done.', content: { 'application/json': { schema: ref(RESPONSES[key] || 'Ok') } } };
  const op = {
    tags: [tagOf(r)],
    summary: words(r.name),
    description: r.about + (r.path === '/health' ? '' : '\n\nTokens: ' + (tokens.length ? 'the relay key, and the token of ' + tokens.join(', ') + '. A route a token reaches can still refuse it, as the description says.' : 'the relay key only.')) + '\n\nFrom ' + MANUAL + '#' + r.section + '.',
    operationId: r.name,
    'x-tokens': tokens,
    responses: { '2XX': success, default: { $ref: '#/components/responses/Problem' } }
  };
  const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => paramOf(m[1], r.path));
  if (params.length) op.parameters = params;
  if (r.path === '/health') op.security = [];
  if (r.method === 'POST') op.requestBody = REQUESTS[key] ? { required: true, content: { 'application/json': { schema: ref(REQUESTS[key]) } } } : { required: false, description: 'JSON. The fields are in the description.', content: { 'application/json': { schema: { type: 'object' } } } };
  return op;
}

function build(html) {
  const version = (html.match(/<code id="api-version">([^<]+)<\/code>/) || [])[1];
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('No <code id="api-version">MAJOR.MINOR.PATCH</code> in ' + MANUAL + '.');
  const paths = {};
  for (const r of rows(html)) {
    const at = paths[r.path] = paths[r.path] || {}, m = r.method.toLowerCase();
    if (at[m]) throw new Error(r.method + ' ' + r.path + ' is in ' + MANUAL + ' twice.');
    at[m] = operation(r);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Building58 relay',
      version,
      description: 'The relay passes commands to a world\'s page and runs the room: tickets, tasks, sessions and reviews. It answers this computer only. Each route\'s description is the manual\'s, from ' + MANUAL + ', where the fields, the tokens and the errors are.',
      license: { name: 'PolyForm Noncommercial 1.0.0', identifier: 'PolyForm-Noncommercial-1.0.0' }
    },
    servers: [{ url: 'http://localhost:8787', description: 'The relay on this computer. npm run office starts it on 8787.' }],
    security: [{ relayKey: [] }, { relayKeyQuery: [] }, { relayKeyCookie: [] }, { sessionToken: [] }],
    tags: Object.values(TAGS).filter(([name]) => Object.values(paths).some((o) => Object.values(o).some((x) => x.tags[0] === name))).map(([name, description]) => ({ name, description })),
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
    components: {
      securitySchemes: {
        relayKey: { type: 'http', scheme: 'bearer', description: 'The relay key, RELAY_KEY: Authorization: Bearer <key>.' },
        relayKeyCookie: { type: 'apiKey', in: 'cookie', name: 'relay_key_<port>', description: 'The cookie the room page gets from a first load with the right ?key=. It is HttpOnly and SameSite=Strict. Its name is relay_key_ and then the relay\'s port (relay_key_8787), not literally relay_key_<port>. The relay refuses it, with 403, when the request has an Origin that is not the relay\'s own address.' },
        relayKeyQuery: { type: 'apiKey', in: 'query', name: 'key', description: 'The relay key in the address, as the page sends it.' },
        sessionToken: { type: 'http', scheme: 'bearer', description: 'A session\'s own token, OFFICE_TICKET_TOKEN. It reaches only the routes its role needs: see ' + MANUAL + '#tokens.' }
      },
      schemas: SCHEMAS,
      responses: {
        Problem: { description: 'Refused. 400 for a bad body, 401 for no key, 403 for a key or token that may not, 404 for an unknown route or id, 409 for a state that does not allow it, 413 for a body over 256 KB, 429 for too soon, 503 and 504 when no page answers.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Problem' } } } }
      }
    }
  };
}

const render = () => JSON.stringify(build(fs.readFileSync(PAGE, 'utf8')), null, 2) + '\n';

if (require.main === module) {
  const want = render();
  if (process.argv.includes('--check')) {
    const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (have !== want) { console.error('docs/openapi.json is out of date. Run npm run openapi.'); process.exit(1); }
  } else {
    fs.writeFileSync(OUT, want);
    console.log('Wrote docs/openapi.json, version ' + JSON.parse(want).info.version + ', ' + Object.values(JSON.parse(want).paths).reduce((n, o) => n + Object.keys(o).length, 0) + ' operations.');
  }
}

module.exports = { build, rows, render, OUT, PAGE, TAGS };
