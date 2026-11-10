// The security officer (relay/security.js): what access the room's sessions run with, by name only,
// the session that reports on it, and the report that stays. Its measures come from relay/access.js
// and the environment relay/session-env.js gives each session.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { relay, until, sessionToken } = require('./helpers.js');
const sessionEnv = require('../session-env.js');
const access = require('../access.js');
const { checkLine } = require('../../.githooks/check-secrets.js');

const CLI = path.join(__dirname, '..', 'ticket.js');
const tokenFor = (s) => until(() => { try { return { 'X-Office-Token': sessionToken(s.sessionId) }; } catch (e) { return null; } }, 'the session');

// Made-up values that look like real keys, built here so this file holds none whole.
const GH = 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const MADE_UP = 'not-a-real-value-' + 'x9y8z7w6';
const LEAKS = [GH, MADE_UP, 'test-key'];
const noLeak = (what, text) => {
  for (const v of LEAKS) assert.ok(!text.includes(v), what + ' holds a value it must not');
  text.split('\n').forEach((line, i) => assert.strictEqual(checkLine(line), null, what + ', line ' + (i + 1) + ', looks like a secret to the secret check'));
};

test('the environment a session gets, by name only (relay/session-env.js)', () => {
  const parent = { HOME: '/h', PATH: '/bin', RELAY_KEY: 'test-key', RELAY_TERMINAL: '1', CLAUDECODE: '1', GH_TOKEN: GH, MY_API_SECRET: MADE_UP, EDITOR: 'vi' };
  const env = sessionEnv.build(parent, { OFFICE_TERMINAL_ID: 't1', OFFICE_TICKET_TOKEN: 'tok' });
  // The relay takes its own key and settings out, and the variables of a Claude Code session that started it.
  assert.strictEqual(env.RELAY_KEY, undefined);
  assert.strictEqual(env.RELAY_TERMINAL, undefined);
  assert.strictEqual(env.CLAUDECODE, undefined);
  // The person's own variables go on, logins included. That is what article 7 says is true today.
  assert.strictEqual(env.GH_TOKEN, GH);
  assert.strictEqual(env.OFFICE_TICKET_TOKEN, 'tok');

  const n = sessionEnv.names(parent);
  assert.deepStrictEqual(n.removed, ['CLAUDECODE', 'RELAY_KEY', 'RELAY_TERMINAL']);
  assert.deepStrictEqual(n.passedOn, ['EDITOR', 'GH_TOKEN', 'HOME', 'MY_API_SECRET', 'PATH']);
  assert.deepStrictEqual(n.loginLike, ['GH_TOKEN', 'MY_API_SECRET']);
  assert.deepStrictEqual(n.added, ['OFFICE_CHANNEL', 'OFFICE_HOOK_URL', 'OFFICE_PANEL_CHANNEL', 'OFFICE_TERMINAL_ID', 'OFFICE_TICKET_TOKEN', 'OFFICE_TICKET_URL']);
  noLeak('the names', JSON.stringify(n, null, 2));
});

test('the logins a session inherits, from the files in the home folder (relay/access.js)', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-access-')));
  try {
    fs.mkdirSync(path.join(home, '.config', 'gh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'gh', 'hosts.yml'), 'github.com:\n    oauth_token: ' + GH + '\n    user: someone\n    git_protocol: https\n');
    fs.mkdirSync(path.join(home, '.ssh'));
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'key');
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519.pub'), 'pub');
    fs.writeFileSync(path.join(home, '.ssh', 'known_hosts'), 'x');
    fs.mkdirSync(path.join(home, '.aws'));
    fs.writeFileSync(path.join(home, '.aws', 'credentials'), '[default]\naws_secret_access_key = ' + MADE_UP + '\n[work]\n');
    fs.writeFileSync(path.join(home, '.npmrc'), '//registry.npmjs.org/:_authToken=' + MADE_UP + '\n');
    fs.mkdirSync(path.join(home, '.docker'));
    fs.writeFileSync(path.join(home, '.docker', 'config.json'), '{ "credsStore": "desktop" }');

    const l = access.logins(home, {});
    const by = (name) => l.find((x) => x.name === name);
    assert.deepStrictEqual(by('gh'), { name: 'gh', file: '~/.config/gh/hosts.yml', found: true, detail: 'hosts: github.com' });
    assert.deepStrictEqual(by('ssh'), { name: 'ssh', file: '~/.ssh', found: true, detail: 'keys: id_ed25519' });
    assert.deepStrictEqual(by('aws'), { name: 'aws', file: '~/.aws/credentials', found: true, detail: 'profiles: default, work' });
    assert.deepStrictEqual(by('npm'), { name: 'npm', file: '~/.npmrc', found: true, detail: 'has a token' });
    assert.strictEqual(by('netrc').found, false);
    assert.deepStrictEqual(by('docker'), { name: 'docker', file: '~/.docker/config.json', found: true, detail: 'no logins' });
    noLeak('the logins', JSON.stringify(l, null, 2));
    // A file with no login in it is no gap: a session cannot use it.
    const gap = access.measure({ env: {}, home, root: '/r' }).gaps.find((g) => /logins in the home folder/.test(g.what)).what;
    assert.match(gap, /gh \(hosts: github.com\); ssh \(keys: id_ed25519\); aws \(profiles: default, work\); npm \(has a token\)\./);
    assert.doesNotMatch(gap, /docker/);
    // Nor is a gh hosts.yml with no host in it (review of PR 185).
    fs.writeFileSync(path.join(home, '.config', 'gh', 'hosts.yml'), '# nothing here\n');
    assert.deepStrictEqual(access.logins(home, {}).find((x) => x.name === 'gh').detail, 'no hosts');
    assert.doesNotMatch(access.measure({ env: {}, home, root: '/r' }).gaps.map((g) => g.what).join(' '), /gh/);
    // Nor an aws credentials file with no profile.
    fs.writeFileSync(path.join(home, '.aws', 'credentials'), '# nothing here\n');
    assert.deepStrictEqual(access.logins(home, {}).find((x) => x.name === 'aws').detail, 'no profiles');
    assert.doesNotMatch(access.measure({ env: {}, home, root: '/r' }).gaps.map((g) => g.what).join(' '), /aws/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the measures compare the access with article 7, and hold names only (relay/access.js)', () => {
  const m = access.measure({
    env: { PATH: '/bin', RELAY_KEY: 'test-key', GH_TOKEN: GH },
    home: '/nowhere-at-all', root: '/repo',
    live: [{ who: 'Ada', role: 'Lead', cwd: '/repo', board: true, merge: true, starts: 2 }, { who: 'Bo', role: 'Dev', cwd: '/repo/.worktrees/x' }],
    claude: { defaultMode: 'acceptEdits', additionalDirectories: ['/tmp/x'], allow: 4, deny: 0 },
    secretCheck: { hookOn: false, found: ['a.js:3: a GitHub token'] }
  });
  assert.deepStrictEqual(m.env.removed, ['RELAY_KEY']);
  assert.deepStrictEqual(m.env.loginLike, ['GH_TOKEN']);
  assert.deepStrictEqual(m.folders.sessions.map((s) => [s.who, s.where]), [['Ada', 'the relay\'s own folder'], ['Bo', 'its own checkout']]);
  assert.deepStrictEqual(m.rungs, { leadMerges: ['Ada'], leadStarts: ['Ada'], leadMovesBoard: ['Ada'] });
  // Each gap names what article 7 asks for and what is true today.
  const gaps = m.gaps.map((g) => g.what);
  assert.ok(gaps.some((g) => /GH_TOKEN/.test(g)), 'login variables pass on: ' + gaps.join(' | '));
  assert.ok(gaps.some((g) => /merge/.test(g) && /Ada/.test(g)), 'a Lead that merges with the person\'s login');
  assert.ok(gaps.some((g) => /secret check/.test(g) && /hook/.test(g)), 'the pre-commit hook is off');
  assert.ok(gaps.some((g) => /relay's own folder/.test(g)), 'a session in the relay\'s own folder');
  assert.ok(m.cannotShow.some((x) => /matches none of the secret check's patterns/.test(x)), 'the report check only knows the patterns and values it is given');
  noLeak('the measures', JSON.stringify(m, null, 2));
});

test('Ask security: a session with its brief, whose report is saved and shown, and holds no key', async (t) => {
  const R = await relay({ RELAY_SECURITY_GRACE_MS: '300', GH_TOKEN: GH, MY_API_SECRET: MADE_UP });
  t.after(() => R.stop());

  const asked = await R.call('POST', '/security/ask', {});
  assert.strictEqual(asked.status, 201, JSON.stringify(asked.body));
  assert.strictEqual((await R.call('POST', '/security/ask', {})).status, 409, 'one at a time');
  const officer = (await R.call('GET', '/terminals')).body.terminals.find((x) => x.id === asked.body.terminal);
  assert.strictEqual(officer.role, 'security');
  assert.strictEqual(officer.work.role, 'security', 'so the org chart puts it in Leadership');

  const screen = await until(async () => { const s = await R.screen(officer.id); return s.includes('GOT[') && s; }, 'the brief');
  const brief = screen.match(/GOT\[(You are the security officer[^\]\r\n]*)\]/)[1];
  for (const words of ['do not decide', 'propose only', 'docs/constitution.md', 'article 7', 'rungs 3 and 4', 'names only', 'never print', 'at most 3 recommendations', 'node "' + CLI + '" access', 'access-report in place of access']) {
    assert.ok(brief.includes(words), 'The brief says: ' + words);
  }
  assert.ok(Buffer.byteLength(brief.replace(CLI, '')) < 850, 'the brief fits one typed line');
  noLeak('the brief', brief);

  // Its token reads the measures and saves a report. It files no ticket and reads no chat.
  const token = await tokenFor(officer);
  const env = { ...process.env, OFFICE_TICKET_URL: R.base + '/tickets', OFFICE_TICKET_TOKEN: token['X-Office-Token'] };
  const raw = execFileSync('node', [CLI, 'access'], { env, encoding: 'utf8' });
  console.log(raw);  // what the security officer reads, for the PR
  const m = JSON.parse(raw).measures;
  // The relay took its key out of its own environment as it started (relay/server.js), so it is not even there to remove.
  assert.ok(m.env.removed.includes('RELAY_TERMINAL') && !m.env.passedOn.includes('RELAY_KEY'));
  assert.ok(m.env.loginLike.includes('GH_TOKEN') && m.env.loginLike.includes('MY_API_SECRET'));
  assert.ok(m.folders.sessions.some((s) => s.who === officer.who));
  noLeak('the measures', raw);
  assert.ok(!raw.includes(token['X-Office-Token']), 'not even its own token');
  assert.strictEqual((await R.call('POST', '/tickets', { title: 'From security' }, token)).status, 401);
  assert.strictEqual((await R.call('GET', '/chat', null, token)).status, 401);
  assert.strictEqual((await R.call('GET', '/coo/measures', null, token)).status, 401);
  const other = (await R.call('POST', '/terminals', { cwd: os.tmpdir() })).body;
  const otherToken = await tokenFor(other);
  assert.strictEqual((await R.call('GET', '/security/measures', null, otherToken)).status, 401);

  // A report that holds a key, or the value of a login it saw by name, is refused, and says so without the value.
  // The secret check's allow marker does not let a report line past it (review of PR 185).
  for (const bad of ['Found ' + GH + ' in the env.', 'Found ' + GH.replace('A1b2', 'Z9y8') + ' secret-check: allow', 'Found ' + GH.replace('A1b2', 'Z9y8') + ' secret-check: secret-check: allowallow', 'MY_API_SECRET is ' + MADE_UP, 'The relay key is test-key.']) {
    const r = await R.call('POST', '/security/report', { text: bad }, token);
    assert.strictEqual(r.status, 400, bad.slice(0, 12));
    assert.strictEqual(r.body.error, 'holds_a_secret');
    noLeak('the refusal', JSON.stringify(r.body));
  }
  const saved = execFileSync('node', [CLI, 'access-report'], { env, encoding: 'utf8', input: '# Access\n\nSessions inherit the gh login (GH_TOKEN).\n' });
  assert.match(saved, /Saved the report/);
  const shown = (await R.call('GET', '/security')).body;
  assert.match(shown.report.text, /inherit the gh login/);
  assert.strictEqual(shown.report.by, officer.who);
  assert.strictEqual(shown.report.measures, undefined, 'the page polls this, so the measures stay out');
  noLeak('the report', JSON.stringify(shown));

  // Its turn ends, and then its session does.
  await R.hook({ hook_event_name: 'Stop', session_id: officer.sessionId.slice(0, 12) });
  await until(async () => !(await R.call('GET', '/terminals')).body.terminals.some((x) => x.id === officer.id), 'the security officer to leave');
  assert.strictEqual((await R.call('GET', '/security')).body.running, null);
});
