// The pre-commit hook, run by real git commits in a throwaway repo. The fake secrets are put
// together here at run time so that this file does not trip the hook itself.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const HOOKS = path.resolve(__dirname, '..', '..', '.githooks');
const AWS = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const GITHUB = 'ghp' + '_' + 'a'.repeat(36);
const CLAUDE = 'sk' + '-ant-' + 'a'.repeat(30);
const PEM = '-----BEGIN RSA ' + 'PRIVATE KEY-----';
const WORD = 'hunter2' + 'hunter2';

function attempt(file, text) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'office-secrets-'));
  try {
    const run = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' });
    execFileSync('git', ['init', '-q', repo]);
    run('commit', '-q', '--allow-empty', '-m', 'init');
    run('config', 'core.hooksPath', HOOKS);
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
    run('add', '-A');
    const r = run('commit', '-qm', 'try');
    return { ok: r.status === 0, err: r.stderr };
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}

const stopped = {
  'an AWS key': ['a.js', 'const k = "' + AWS + '";\n'],
  'a GitHub token': ['a.md', 'token ' + GITHUB + '\n'],
  'an Anthropic key': ['a.sh', 'export KEY=' + CLAUDE + '\n'],
  'a private key': ['a.txt', PEM + '\n'],
  'a quoted password': ['a.js', 'const password = "' + WORD + '";\n'],
  'an unquoted password in config': ['a.yml', 'db_password: ' + WORD + '1!\n'],
  'a password in a URL': ['a.js', 'connect("postgres://me:' + WORD + '@db.example.com/x");\n'],
  'a .env file': ['.env', 'A=1\n'],
  'a nested key file': ['deploy/server.pem', 'x\n'],
  'an .envrc': ['.envrc', 'export A=1\n']
};
for (const [name, [file, text]] of Object.entries(stopped)) {
  test('stops ' + name, () => { assert.strictEqual(attempt(file, text).ok, false); });
}

const allowed = {
  'ordinary code': ['a.js', 'const token = crypto.randomBytes(16).toString("hex");\nconst key = process.env.RELAY_KEY;\n'],
  'the placeholder the docs use': ['a.md', 'RELAY_KEY=pick-a-key npm run relay\napi_key: "your-key-here"\n'],
  'a variable passed along': ['a.js', 'send({ password: userPassword, secret: value });\n'],
  'a test value': ['a.js', 'const password = "test-password";\n'],
  'a line marked as a false alarm': ['a.js', 'const password = "' + WORD + '"; // secret-check: allow\n'],
  'a .env.example': ['.env.example', 'A=\n'],
  'an .envrc.example': ['.envrc.example', 'export A=\n']
};
for (const [name, [file, text]] of Object.entries(allowed)) {
  test('allows ' + name, () => { const r = attempt(file, text); assert.strictEqual(r.ok, true, r.err); });
}

test('says where the secret is without repeating it', () => {
  const r = attempt('a.js', '\n\nconst k = "' + AWS + '";\n');
  assert.match(r.err, /a\.js:3: an AWS access key/);
  assert.ok(!r.err.includes(AWS));
});

// CI (T-20): the same check on what a pull request adds, for commits that got past the hook.
const CHECK = path.join(HOOKS, 'check-secrets.js');
function branch(commits) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'office-secrets-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', repo]);
  const shas = [];
  for (const files of commits) {
    for (const [file, text] of Object.entries(files)) {
      if (text === null) { fs.rmSync(path.join(repo, file)); continue; }
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
    }
    git('add', '-A');
    git('commit', '-q', '--no-verify', '--allow-empty', '-m', 'c' + shas.length);
    shas.push(git('rev-parse', 'HEAD'));
  }
  return { repo, shas, done: () => fs.rmSync(repo, { recursive: true, force: true }) };
}
function scan(repo, ...args) {
  const r = spawnSync('node', [CHECK, ...args], { cwd: repo, encoding: 'utf8' });
  return { ok: r.status === 0, err: r.stderr };
}

test('--diff finds a secret that a branch adds, even past --no-verify', () => {
  const b = branch([{ 'a.js': 'x\n' }, { 'a.js': 'x\nconst k = "' + AWS + '";\n' }, { 'deploy/server.pem': 'x\n' }]);
  try {
    const r = scan(b.repo, '--diff', b.shas[0]);
    assert.strictEqual(r.ok, false);
    assert.match(r.err, /a\.js:2: an AWS access key/);
    assert.match(r.err, /deploy\/server\.pem: a file that holds secrets/);
    assert.ok(!r.err.includes(AWS), 'it never repeats the secret');
  } finally { b.done(); }
});

test('--diff reads only what the branch adds', () => {
  const b = branch([{ 'old.js': 'const k = "' + AWS + '";\n' }, { 'a.js': 'const key = process.env.RELAY_KEY;\n' }]);
  try {
    const r = scan(b.repo, '--diff', b.shas[0]);
    assert.strictEqual(r.ok, true, r.err);
  } finally { b.done(); }
});

test('--diff passes once a later commit takes the secret out, and says the key is in the history', () => {
  const b = branch([{ 'a.js': 'x\n' }, { 'a.js': 'x\nconst k = "' + AWS + '";\n' }, { 'a.js': 'x\n' }]);
  try {
    assert.strictEqual(scan(b.repo, '--diff', b.shas[0]).ok, true);
    assert.match(scan(b.repo, '--diff', b.shas[0], b.shas[1]).err, /history/);
  } finally { b.done(); }
});

test('--diff fails when it cannot read the diff', () => {
  const b = branch([{ 'a.js': 'x\n' }]);
  try {
    const r = scan(b.repo, '--diff', 'no-such-commit');
    assert.strictEqual(r.ok, false);
    assert.match(r.err, /could not read/i);
  } finally { b.done(); }
});

// --all (T-195): every tracked file, not just what a branch adds, for CI's Secret scan job.
test('--all finds a secret already in a tracked file, and never repeats it', () => {
  const b = branch([{ 'old.js': 'x\nconst k = "' + AWS + '";\n', 'b.md': 'fine\n' }, { 'a.js': 'const key = process.env.RELAY_KEY;\n' }]);
  try {
    const r = scan(b.repo, '--all');
    assert.strictEqual(r.ok, false);
    assert.match(r.err, /old\.js:2: an AWS access key/);
    assert.ok(!r.err.includes(AWS), 'it never repeats the secret');
  } finally { b.done(); }
});

test('--all stops a tracked .env, .env.local, .envrc or .envrc.local, but not a .env.example or .envrc.example', () => {
  const b = branch([{ '.env.local': 'A=1\n', '.envrc': 'A=1\n', '.envrc.local': 'A=1\n', 'x/.env': 'A=1\n', '.env.example': 'A=\n', '.envrc.example': 'A=\n' }]);
  try {
    const r = scan(b.repo, '--all');
    assert.strictEqual(r.ok, false);
    for (const f of ['.env.local', '.envrc', '.envrc.local', 'x/.env']) assert.ok(r.err.includes('  ' + f + ': a file that holds secrets'), f);
    assert.ok(!r.err.includes('.env.example'));
    assert.ok(!r.err.includes('.envrc.example'));
  } finally { b.done(); }
});

test('--all passes a clean tree, skips binary and untracked files, and keeps secret-check: allow', () => {
  const b = branch([{ 'a.js': 'const password = "' + WORD + '"; // secret-check: allow\n', 'img.bin': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(AWS)]) }]);
  try {
    fs.writeFileSync(path.join(b.repo, 'untracked.js'), 'const k = "' + AWS + '";\n');
    fs.mkdirSync(path.join(b.repo, 'sub'));
    const r = spawnSync('node', [CHECK, '--all'], { cwd: path.join(b.repo, 'sub'), encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /no secrets/);
  } finally { b.done(); }
});

test('--all fails outside a git checkout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-secrets-'));
  try {
    const r = spawnSync('node', [CHECK, '--all'], { cwd: dir, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /could not read/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--all fails on a tracked file it cannot read', { skip: process.getuid && process.getuid() === 0 }, () => {
  const b = branch([{ 'locked/a.js': 'x\n' }]);
  try {
    fs.chmodSync(path.join(b.repo, 'locked'), 0o000);
    const r = scan(b.repo, '--all');
    assert.strictEqual(r.ok, false);
    assert.match(r.err, /could not read/);
  } finally { fs.chmodSync(path.join(b.repo, 'locked'), 0o755); b.done(); }
});

test('--all skips a tracked file deleted here, even when a file now stands where its folder was', () => {
  const b = branch([{ 'gone/a.js': 'x\n', 'moved/b.js': 'x\n' }]);
  try {
    fs.rmSync(path.join(b.repo, 'gone'), { recursive: true });
    fs.rmSync(path.join(b.repo, 'moved'), { recursive: true });
    fs.writeFileSync(path.join(b.repo, 'moved'), 'y\n');
    const r = spawnSync('node', [CHECK, '--all'], { cwd: b.repo, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /no secrets/);
  } finally { b.done(); }
});
