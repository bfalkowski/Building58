// A ticket store that refuses a change answers 409 with its own message, not 502, so the Board can show why.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

const NOTE = 'Issue #380 has a note this relay\'s key did not sign, so its approvedBy cannot change.';

test('an approve the store refuses answers 409 with the store\'s message', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-refusing-'));
  const file = path.join(dir, 'store.js');
  fs.writeFileSync(file, 'const m = require(' + JSON.stringify(path.join(__dirname, 'memory-store.js')) + ');\n'
    + 'exports.open = () => { const s = m.open(); const update = s.update; s.update = async (p, id, c) => { if ("approvedBy" in c) throw Object.assign(new Error(' + JSON.stringify(NOTE) + '), { refused: true }); return update(p, id, c); }; const create = s.create; s.create = (p, f) => create(p, { ...f, status: "ready", createdBy: "Lead", approvedBy: null }); return s; };\n');
  const R = await H.relay({ RELAY_TICKET_STORE: file });
  t.after(R.stop);
  const repo = H.makeRepo(R.home);
  const id = (await R.call('POST', '/tickets', { title: 'Waits', repo, body: 'x' })).body.ticket.id;
  const r = await R.call('POST', '/tickets/approve-ready', { ids: [id] });
  assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(r.body.error, 'store_refused');
  assert.strictEqual(r.body.message, NOTE);
});
