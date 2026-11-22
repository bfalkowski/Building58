// Builds docs/openapi.json, the relay's API as an OpenAPI 3.1 document, from the route tables in
// docs/manual/relay.html, so the manual stays the one place the routes are described. The version is
// the one the page gives in <code id="api-version">. npm run openapi writes the file, and
// relay/test/openapi.test.js checks that the file is what this builds, that each route in it answers,
// and that a change since main came with a new version (docs/constitution.md, article 15).
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
  'tasks/id': { pattern: '^[0-9a-f]{6}$', description: 'The task\'s id.' },
  'checkouts/id': { pattern: '^[0-9a-f]{6}$', description: 'The checkout\'s id.' },
  'terminals/id': { pattern: '^[0-9a-f]{12}$', description: 'The session\'s id on the relay.' },
  'rounds/id': { pattern: '^[0-9a-f]{8}$', description: 'The round\'s id.' },
  seat: { pattern: '^S\\d{1,2}$', description: 'The seat, such as S1.' },
  name: { pattern: '^[\\w-]{1,64}$', description: 'The chat channel\'s name.' },
  pid: { pattern: '^\\d+$', description: 'The old relay\'s process id.' },
  role: { pattern: '^(coo|security)$', description: 'The officer: coo or security.' }
};

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
  const parts = r.path.split('/').filter(Boolean), tag = r.path === '/health' ? 'relay' : parts[0] === 'channels' && parts[2] ? parts[2].replace(/[{}]/g, '') : 'channel';
  const key = r.method + ' ' + r.path.replace('/channels/{channel}', ''), stream = /\/stream$/.test(r.path), tokens = tokensOf(r);
  const success = stream ? { description: 'A stream of server-sent events, open until either side closes it.', content: { 'text/event-stream': { schema: { type: 'string' } } } }
    : { description: 'Done.', content: { 'application/json': { schema: ref(RESPONSES[key] || 'Ok') } } };
  const op = {
    tags: [r.section === 'calls' ? 'calls' : tag],
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
    security: [{ relayKey: [] }, { relayKeyQuery: [] }, { sessionToken: [] }],
    tags: [{ name: 'calls', description: 'Calls any caller uses: commands, events and the page.' }, ...[...new Set(Object.values(paths).flatMap((o) => Object.values(o).map((x) => x.tags[0])))].filter((t) => t !== 'calls').sort().map((name) => ({ name }))],
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
    components: {
      securitySchemes: {
        relayKey: { type: 'http', scheme: 'bearer', description: 'The relay key, RELAY_KEY: Authorization: Bearer <key>.' },
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

module.exports = { build, rows, render, OUT, PAGE };
