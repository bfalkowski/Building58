// The suite's own cleanup (T-184). Two relays on one home once left the second running when the
// first removed the folder under it, and that one test file then kept the whole run from ending.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const { relay, until } = require('./helpers.js');

test('removing a home stops every relay still on it first', async (t) => {
  const R = await relay(); t.after(R.stop);
  const second = await relay({}, R.home); t.after(second.stop);
  await R.stop();
  assert.ok(second.child.exitCode !== null || second.child.signalCode, 'the second relay is stopped');
  assert.ok(!fs.existsSync(R.home), 'and the home is gone');
});

test('a test file that never ends fails with a clear message, and does not hang the run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-hang-'));
  const pidFile = path.join(dir, 'pid');
  try {
    const env = { ...process.env, TEST_FILE_SECONDS: '3', HANG_PID_FILE: pidFile };
    delete env.NODE_TEST_CONTEXT;  // or node --test inside this test skips the file
    const r = spawnSync(process.execPath, [path.join(__dirname, 'run.js'), path.join(__dirname, 'hang.fixture.js')],
      { env, encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 1, 'the run ends, and fails: ' + r.stdout + r.stderr);
    assert.match(r.stdout, /hang\.fixture\.js did not end within 3 seconds, so it was stopped/);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
    await until(() => !alive(), 'what the file left running to be stopped too');  // a killed process is gone once the system reaps it
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// A fake gh child, or the relay's last gh poll, can still write into its folder as a test ends, so a
// plain rmSync of that folder fails with ENOTEMPTY (T-140). Every test removes it with removeDir, which retries.
// In a file that makes a fake gh folder, every folder made gets a name and a removeDir, and any other rm
// removes one file, a path.join with no recursive, so no plain removal hides behind another name.
// This file is left out: its examples above break the rule on purpose.
const fakeGhProblems = (name, text) => {
  const makes = [...text.matchAll(/mkdtempSync\([^\n]*?['"`]office-gh-/g)];
  if (!makes.length) return [];
  const at = (i) => name + ':' + text.slice(0, i).split('\n').length;
  const problems = [];
  const made = new Map();
  for (const m of makes) {
    const before = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index).match(/([\w$.]+)\s*=\s*[^=]*$/);
    if (!before) problems.push(at(m.index) + ' makes a fake gh folder with no name to remove it by');
    else made.set(before[1], [...(made.get(before[1]) || []), m.index]);
  }
  for (const [v, places] of made) {
    const removed = text.match(new RegExp('removeDir\\(\\s*' + v.replace(/\./g, '\\.') + '\\s*\\)', 'g')) || [];
    for (const i of places.slice(removed.length)) problems.push(at(i) + ' never removes ' + v + ' with removeDir');
  }
  for (const m of text.matchAll(/\b(?:rm|rmdir)(?:Sync)?\(/g)) {
    let depth = 1, i = m.index + m[0].length;
    for (; i < text.length && depth; i++) depth += text[i] === '(' ? 1 : text[i] === ')' ? -1 : 0;
    const args = text.slice(m.index + m[0].length, i - 1).trim();
    const oneFile = /^path\.join\([\s\S]*\)\s*(,\s*\{[^}]*\})?$/.test(args) && !/recursive/.test(args);
    if (!oneFile) problems.push(at(m.index) + ' removes a folder with ' + m[0] + args.split('\n')[0] + '), not removeDir');
  }
  return problems;
};

test('the fake gh guard sees each way a test can make or remove the folder', () => {
  const make = (lhs, q = "'") => lhs + ' = fs.mkdtempSync(path.join(os.tmpdir(), ' + q + 'office-gh-' + q + '));\n';
  const cases = [
    ['let', make('let gh') + 't.after(() => fs.rmSync(gh, { recursive: true, force: true }));\n'],
    ['double quotes', make('const gh', '"') + 't.after(() => fs.rmSync(gh, { recursive: true, force: true }));\n'],
    ['a folder kept on an object', make('o.ghDir') + 't.after(() => fs.rmSync(o.ghDir, { recursive: true, force: true }));\n'],
    ['a destructured rmSync', "const { rmSync } = fs;\n" + make('const gh') + 't.after(() => rmSync(gh, { recursive: true, force: true }));\n'],
    ['a name kept under another name', make('const gh') + 'const dir = gh;\nt.after(() => fs.rmSync(dir, { recursive: true, force: true }));\n'],
    ['a rmSync over two lines', make('const gh') + 't.after(() => fs.rmSync(gh, {\n  recursive: true, force: true }));\n'],
    ['never removed', make('const gh') + 'run(gh);\n'],
    ['two folders under one name, removed once', make('const gh') + 't.after(() => removeDir(gh));\n' + make('const gh') + 'run(gh);\n'],
    ['made with no name', 'run(fs.mkdtempSync(path.join(os.tmpdir(), \'office-gh-\')));\n'],
  ];
  for (const [what, text] of cases) assert.notDeepStrictEqual(fakeGhProblems('x.test.js', text), [], 'it catches: ' + what);
  const fine = make('const gh') + make('o.ghDir', '"') + "fs.rmSync(path.join(gh, 'merged.log'), { force: true });\n"
    + 't.after(() => { removeDir(gh); removeDir(o.ghDir); });\n';
  assert.deepStrictEqual(fakeGhProblems('x.test.js', fine), [], 'and passes removeDir, and a single file removed inside the folder');
  assert.deepStrictEqual(fakeGhProblems('x.test.js', "fs.rmSync(dir, { recursive: true, force: true });\n"), [],
    'and leaves alone a file that makes no fake gh folder');
});

test('every fake gh folder is removed with removeDir, which retries while a writer finishes', () => {
  const problems = fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') && f !== path.basename(__filename))
    .flatMap((name) => fakeGhProblems(name, fs.readFileSync(path.join(__dirname, name), 'utf8')));
  assert.deepStrictEqual(problems, [], 'these fake gh folders are not removed with removeDir');
});

test('removeDir waits out a writer that is still adding files', async () => {
  const { removeDir } = require('./helpers.js');
  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gh-'));
  // Another process, as a fake gh is, keeps adding to the folder for 400 ms while the folder is removed.
  const writer = "const fs = require('fs'), p = require('path'), d = process.argv[1], end = Date.now() + 400; console.log('go');" +
    "for (let n = 0; Date.now() < end; n++) { try { fs.mkdirSync(p.join(d, 'd' + n)); fs.writeFileSync(p.join(d, 'd' + n, 'f'), 'x'); } catch (e) { /* gone */ } }";
  const child = spawn(process.execPath, ['-e', writer, ghDir], { stdio: ['ignore', 'pipe', 'inherit'] });
  const ended = new Promise((r) => child.once('exit', r));
  await new Promise((r) => child.stdout.once('data', r));
  await new Promise((r) => setTimeout(r, 50));
  try { removeDir(ghDir); } finally { await ended; }
  assert.ok(!fs.existsSync(ghDir), 'the folder is gone');
});
