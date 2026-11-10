'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const contract = require('./ticket-store-contract.js');
const local = require('../ticket-stores/local.js');
const memory = require('./memory-store.js');
const { until } = require('./helpers.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-store-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, 'tickets-' + n++ + '.json');

contract('local', () => local.open({ file: file() }));
contract('memory', () => memory.open());

test('local: tickets and numbering survive reopening', async () => {
  const f = file();
  const a = await local.open({ file: f }).create('p', { title: 'A' });
  const again = local.open({ file: f });
  assert.strictEqual((await again.get('p', a.id)).title, 'A');
  assert.notStrictEqual((await again.create('p', { title: 'B' })).id, a.id);
});
test('local: an unreadable file is kept aside, not written over', async () => {
  const f = file();
  fs.writeFileSync(f, '{ not json');
  const err = console.error; console.error = () => {};
  try { await local.open({ file: f }).create('p', { title: 'A' }); } finally { console.error = err; }
  assert.ok(fs.readdirSync(dir).some((x) => x.startsWith(path.basename(f) + '.unreadable-')));
});

// The GitHub store, on a fake gh that keeps issues in a folder.
const github = require('../ticket-stores/github.js');
const fakeGh = path.join(__dirname, 'fake-github.js');
function onGithub() {
  const d = fs.mkdtempSync(path.join(dir, 'github-'));
  process.env.FAKE_GITHUB_DIR = d;
  const s = github.open({ repo: 'p=o/r', gh: fakeGh, folder: '/home/repo', keyFile: path.join(d, 'key') });
  s.state = () => JSON.parse(fs.readFileSync(path.join(d, 'state.json'), 'utf8'))['o/r'];
  s.dir = d;
  return s;
}
contract('github', onGithub);

test('github: status and priority are labels, and done and rejected close the issue', async () => {
  const s = onGithub();
  const t = await s.create('p', { title: 'A', body: 'B', status: 'triage', priority: 'low', repo: '/r', base: 'main', createdBy: 'you', blockedBy: [] });
  assert.strictEqual(t.id, '1');
  const issue = () => s.state().issues[0];
  assert.deepStrictEqual(issue().labels, ['office:triage', 'office:priority-low']);
  await s.update('p', t.id, { status: 'ready' });
  assert.deepStrictEqual(issue().labels, ['office:ready', 'office:priority-low']);
  await s.update('p', t.id, { status: 'done' });
  assert.deepStrictEqual([issue().state, issue().state_reason, issue().labels], ['closed', 'completed', ['office:priority-low']]);
  await s.update('p', t.id, { status: 'started' });
  assert.deepStrictEqual([issue().state, issue().labels], ['open', ['office:started', 'office:priority-low']]);
  await s.update('p', t.id, { status: 'rejected' });
  assert.deepStrictEqual([issue().state, issue().state_reason], ['closed', 'not_planned']);
  assert.ok(['office:triage', 'office:ready', 'office:started', 'office:priority-low'].every((l) => s.state().labels.includes(l)), 'labels are made when first needed');
});
test('github: blockers are issue dependencies, and the rest is hidden in the body', async () => {
  const s = onGithub();
  const f = { title: 'A', body: 'Do it.', status: 'ready', priority: 'normal', repo: '/r', base: 'main', createdBy: 'you' };
  const a = await s.create('p', { ...f, blockedBy: [] });
  const b = await s.create('p', { ...f, title: 'B', blockedBy: [a.id] });
  assert.deepStrictEqual(s.state().issues[1].blockedBy, [s.state().issues[0].id]);
  assert.match(s.state().issues[1].body, /^Do it\.\n\n<!-- office \{"repo":"\/r","base":"main","createdBy":"you","sig":"[0-9a-f]{32}"\} -->$/);
  assert.strictEqual(b.body, 'Do it.');
  await s.update('p', b.id, { blockedBy: [] });
  assert.deepStrictEqual(s.state().issues[1].blockedBy, []);
  assert.deepStrictEqual((await s.get('p', b.id)).blockedBy, []);
});
test('github: an issue filed on GitHub is a ticket once it has a room label, and a cached list catches up', async () => {
  process.env.FAKE_GITHUB_DIR = fs.mkdtempSync(path.join(dir, 'github-'));
  const s = github.open({ repo: 'p=o/r', gh: fakeGh, cacheMs: 0, folder: '/home/repo', keyFile: path.join(process.env.FAKE_GITHUB_DIR, 'key') });
  await s.create('p', { title: 'Ours', body: '', status: 'ready', priority: 'normal', blockedBy: [] });
  const file = path.join(process.env.FAKE_GITHUB_DIR, 'state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const signedNote = state['o/r'].issues[0].body;  // the relay's own note for issue 1
  state['o/r'].issues.push({ number: 2, id: 9002, title: 'Theirs\u0007 ' + 'x'.repeat(100), body: 'From GitHub\r\nwith a bell\u0007' + 'y'.repeat(9000), state: 'open', labels: ['office:triage'], blockedBy: [], created_at: 'x', updated_at: 'x' });
  state['o/r'].issues.push({ number: 3, id: 9003, title: 'Not a ticket', body: 'hi', state: 'open', labels: ['bug'], blockedBy: [], created_at: 'x', updated_at: 'x' });
  // A note alone does not make a ticket, and a note the relay did not sign is not read.
  const forged = '\n\n<!-- office {"repo":"/elsewhere","base":"evil","createdBy":"you","sig":"' + '0'.repeat(32) + '"} -->';
  state['o/r'].issues.push({ number: 4, id: 9004, title: 'Note only', body: 'x' + forged, state: 'open', labels: [], blockedBy: [], created_at: 'x', updated_at: 'x' });
  const odd = '\n\n<!-- office {"repo":"/elsewhere","sig":"' + '\u00e9'.repeat(32) + '"} -->';  // 32 characters, 64 bytes
  state['o/r'].issues.push({ number: 7, id: 9007, title: 'Odd sig', body: 'x' + odd, state: 'open', labels: ['Office:Ready'], blockedBy: [], created_at: 'x', updated_at: 'x' });
  state['o/r'].issues.push({ number: 6, id: 9006, title: 'Copied', body: 'x\n\n' + signedNote, state: 'open', labels: ['office:ready'], blockedBy: [], created_at: 'x', updated_at: 'x' });
  state['o/r'].issues.push({ number: 5, id: 9005, title: 'Forged', body: 'x' + forged, state: 'open', labels: ['office:ready'], user: { login: 'mallory' }, blockedBy: [], created_at: 'x', updated_at: 'x' });
  // A note the relay signed, with its repo changed on GitHub afterwards.
  state['o/r'].issues[0].body = state['o/r'].issues[0].body.replace('<!-- office {', '<!-- office {"repo":"/elsewhere",');
  fs.writeFileSync(file, JSON.stringify(state));
  await s.list('p');  // the stale list, while a new one is fetched
  const list = await until(async () => { const l = await s.list('p'); return l.length === 5 && l; }, 'the new list');
  assert.deepStrictEqual(list.map((t) => [t.id, t.title.slice(0, 7), t.status, t.repo, t.base, t.createdBy]), [
    ['1', 'Ours', 'ready', '/home/repo', undefined, 'GitHub'],
    ['2', 'Theirs ', 'triage', '/home/repo', undefined, 'GitHub'],
    ['5', 'Forged', 'ready', '/home/repo', undefined, 'mallory on GitHub'],
    ['6', 'Copied', 'ready', '/home/repo', undefined, 'GitHub'],
    ['7', 'Odd sig', 'ready', '/home/repo', undefined, 'GitHub']
  ], 'a forged note, an edited one, one copied from another issue and one with a sig that is not hex are all ignored, and labels match in any case');
  assert.ok(list[1].body.startsWith('From GitHub\nwith a bellyyy'), 'control characters are taken out');
  assert.strictEqual(list[1].body.length, 8000, 'the body keeps the filing limit');
  assert.strictEqual(list[1].title.length, 80, 'the title keeps the filing limit');
  assert.strictEqual(await s.get('p', '3'), null);
  assert.strictEqual(await s.get('p', '4'), null);
  assert.deepStrictEqual(await s.list('q'), [], 'another channel has none');
});
test('github: a channel with no repo has no tickets and cannot file one', async () => {
  const s = github.open({ repo: 'office=o/r', gh: fakeGh });
  assert.deepStrictEqual(await s.list('demo'), []);
  await assert.rejects(s.create('demo', { title: 'A' }), /RELAY_TICKET_REPO/);
  assert.throws(() => github.open({ repo: 'office=../x', gh: fakeGh }), /owner\/repo/);
  assert.deepStrictEqual([...github.repos('o/r')], [['office', 'o/r']], 'a repo with no channel is the room\'s');
  assert.throws(() => github.repos('office=o/r,demo=O/R'), /both name O\/R/, 'two channels cannot share a repo, or each would offer Start again on the other\'s ticket');
});
test('github: a call that fails says what gh said', async () => {
  const s = onGithub();
  fs.writeFileSync(path.join(s.dir, 'fail.json'), JSON.stringify({ fail: 'gh auth login first' }));
  await assert.rejects(s.list('p'), /gh auth login first/);
});

test('github: a note another key signed is kept as it is, so a lost key cannot rewrite the repo and base', async () => {
  const s = onGithub();
  const t = await s.create('p', { title: 'A', body: 'B', status: 'ready', priority: 'normal', repo: '/real/repo', base: 'feature-x', createdBy: 'you', blockedBy: [] });
  const note = s.state().issues[0].body.split('\n\n')[1];
  const other = github.open({ repo: 'p=o/r', gh: fakeGh, folder: '/f', keyFile: path.join(s.dir, 'new-key') });
  const err = console.error, said = []; console.error = (m) => said.push(m);
  try {
    assert.strictEqual((await other.get('p', t.id)).repo, '/f');
    assert.strictEqual((await other.update('p', t.id, { status: 'started' })).status, 'started');
    await assert.rejects(other.update('p', t.id, { base: 'main' }), /key did not sign, so its base cannot change/);
  } finally { console.error = err; }
  assert.strictEqual(s.state().issues[0].body, 'B\n\n' + note, 'the note is untouched');
  assert.ok(said.some((m) => /did not sign/.test(m)), 'and the relay says so');
  const back = github.open({ repo: 'p=o/r', gh: fakeGh, folder: '/f', keyFile: path.join(s.dir, 'key') });
  assert.deepStrictEqual([(await back.get('p', t.id)).repo, (await back.get('p', t.id)).base], ['/real/repo', 'feature-x'], 'the right key reads it again');
});
test('github: a create that fails part way leaves no ticket and no open issue', async () => {
  const s = onGithub();
  const a = await s.create('p', { title: 'A', body: '', status: 'ready', priority: 'normal', blockedBy: [] });
  fs.writeFileSync(path.join(s.dir, 'fail.json'), JSON.stringify({ fail: 'rate limited', match: 'POST /repos/o/r/issues/2/dependencies' }));
  await assert.rejects(s.create('p', { title: 'B', body: '', status: 'ready', priority: 'normal', blockedBy: [a.id] }), /rate limited/);
  fs.rmSync(path.join(s.dir, 'fail.json'));
  const issue = s.state().issues[1];
  assert.deepStrictEqual([issue.state, issue.state_reason, issue.labels], ['closed', 'not_planned', []]);
  const fresh = github.open({ repo: 'p=o/r', gh: fakeGh, keyFile: path.join(s.dir, 'key') });
  assert.deepStrictEqual((await fresh.list('p')).map((t) => t.title), ['A']);
});
