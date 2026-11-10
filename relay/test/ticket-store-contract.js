// What every ticket store has to do. To test your own:
//   require('./ticket-store-contract.js')('my tracker', () => require('/path/to/store.js').open());
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const fields = (over) => Object.assign({ title: 'A', body: 'B', status: 'ready', priority: 'normal', repo: '/r', base: 'main', createdBy: 'you', blockedBy: [] }, over);

module.exports = function contract(name, make) {
  test(name + ': keeps what it is given and picks an id', async () => {
    const s = make();
    assert.strictEqual(typeof s.name, 'string');
    const t = await s.create('p', fields({ blockedBy: ['X'] }));
    assert.ok(t.id && typeof t.id === 'string' && /^[\w-]{1,64}$/.test(t.id), 'an id fits the relay\'s routes');
    assert.ok(t.createdAt && t.updatedAt);
    assert.deepStrictEqual([t.title, t.body, t.status, t.priority, t.repo, t.base, t.createdBy, t.blockedBy], ['A', 'B', 'ready', 'normal', '/r', 'main', 'you', ['X']]);
    assert.deepStrictEqual(await s.get('p', t.id), t);
  });
  test(name + ': ids differ and the list is oldest first', async () => {
    const s = make();
    const a = await s.create('p', fields({ title: 'one' })), b = await s.create('p', fields({ title: 'two' }));
    assert.notStrictEqual(a.id, b.id);
    assert.deepStrictEqual((await s.list('p')).map((t) => t.title), ['one', 'two']);
  });
  test(name + ': update changes only what it is told', async () => {
    const s = make();
    const t = await s.create('p', fields());
    const u = await s.update('p', t.id, { status: 'started', id: 'other', createdAt: 'never' });
    assert.strictEqual(u.status, 'started');
    assert.strictEqual(u.id, t.id);
    assert.strictEqual(u.createdAt, t.createdAt);
    assert.strictEqual(u.title, 'A');
    assert.strictEqual((await s.get('p', t.id)).status, 'started');
  });
  test(name + ': missing tickets are null, and projects are separate', async () => {
    const s = make();
    const t = await s.create('p', fields());
    assert.strictEqual(await s.get('p', 'NOPE-1'), null);
    assert.strictEqual(await s.update('p', 'NOPE-1', { status: 'done' }), null);
    assert.strictEqual(await s.get('q', t.id), null);
    assert.deepStrictEqual(await s.list('q'), []);
  });
  test(name + ': what it returns is a copy', async () => {
    const s = make();
    const t = await s.create('p', fields());
    t.title = 'changed';
    (await s.list('p'))[0].title = 'changed too';
    assert.strictEqual((await s.get('p', t.id)).title, 'A');
  });
};
