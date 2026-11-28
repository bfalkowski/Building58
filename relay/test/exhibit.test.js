// Reading the exhibit that the nightly run stored (relay/exhibit.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config.js');

const HEAD = 'c36bfef' + '0'.repeat(33);
const PR = 'https://github.com/acme/widgets/pull/7';
const stored = (over) => Object.assign({ pr: 7, head: HEAD, repo: 'Acme/Widgets', verdict: 'meets_policy' }, over);
const want = { repo: 'acme/widgets', pr: '7', head: HEAD };

function withGh(answers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-exhibit-'));
  fs.writeFileSync(path.join(dir, 'answers.json'), JSON.stringify(answers));
  process.env.GH_CMD = path.join(__dirname, 'fake-gh.js');
  process.env.FAKE_GH_DIR = dir;
  delete require.cache[require.resolve('../gh.js')];
  delete require.cache[require.resolve('../exhibit.js')];
  return { exhibit: require('../exhibit.js'), calls: () => fs.readFileSync(path.join(dir, 'calls.log'), 'utf8') };
}
const AT = 'repos/acme/widgets/contents/prs/7/' + HEAD + '.json';

const { verdictOf } = require('../exhibit.js');

test('it reads the verdict of an exhibit stored for this PR, head and repo', () => {
  assert.deepStrictEqual(verdictOf(stored(), want), { verdict: 'meets_policy', commit: HEAD });
  assert.strictEqual(verdictOf(stored({ verdict: 'needs_person' }), want).verdict, 'needs_person');
  assert.strictEqual(verdictOf(stored({ verdict: 'error' }), want).verdict, 'error');
});
test('it says nothing for an exhibit of another PR, head or repo, or with an unknown verdict', () => {
  assert.strictEqual(verdictOf(stored({ pr: 8 }), want), null);
  assert.strictEqual(verdictOf(stored({ head: 'a'.repeat(40) }), want), null);
  assert.strictEqual(verdictOf(stored({ repo: 'acme/other' }), want), null);
  assert.strictEqual(verdictOf(stored({ verdict: 'great' }), want), null);
  assert.strictEqual(verdictOf(null, want), null);
  assert.strictEqual(verdictOf('meets_policy', want), null);
});
test('read asks the exhibit-data branch for the file of the head, and posts nothing', async () => {
  const { exhibit, calls } = withGh({ api: { [AT]: stored() } });
  assert.deepStrictEqual(await exhibit.read(PR, undefined, HEAD), { verdict: 'meets_policy', commit: HEAD });
  assert.match(calls(), /contents\/prs\/7\/c36bfef0+\.json\?ref=exhibit-data/);
  assert.doesNotMatch(calls(), /comment/);
});
test('read says null when no exhibit is stored for the head, and failed when gh could not say', async () => {
  assert.strictEqual(await withGh({ failApi: { [AT]: 'gh: Not Found (HTTP 404)' } }).exhibit.read(PR, undefined, HEAD), null);
  assert.deepStrictEqual(await withGh({ failApi: { [AT]: 'gh: Bad gateway (HTTP 502)' } }).exhibit.read(PR, undefined, HEAD), { failed: 'gh could not read the stored exhibit' });
  assert.deepStrictEqual(await withGh({ api: {} }).exhibit.read(PR, undefined, HEAD), null, 'an answer that is not an exhibit is no verdict');
  assert.ok((await withGh({}).exhibit.read('not a link', undefined, HEAD)).failed);
  assert.ok((await withGh({}).exhibit.read(PR, undefined, 'abc')).failed, 'it needs the full head commit');
});
test('the level 6 switch is off by default', () => {
  assert.strictEqual(config.get('autopilotExhibit'), false);
});
