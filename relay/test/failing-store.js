// A store that goes away for some updates, chosen by the words in the ticket's title.
// A ticket whose title has "goes-missing" is not found once the file FAKE_STORE_GONE names exists,
// as if the store was reset after it started. One whose title has "no-rank" cannot have its rank written.
'use strict';
const fs = require('fs');
const memory = require('./memory-store.js');
function open() {
  const s = memory.open();
  const gone = (t) => t && t.title.includes('goes-missing') && process.env.FAKE_STORE_GONE && fs.existsSync(process.env.FAKE_STORE_GONE);
  return { ...s, name: 'failing', async get(p, id) {
    const t = await s.get(p, id);
    return gone(t) ? null : t;
  }, async update(p, id, changes) {
    const t = await s.get(p, id);
    if (t && (t.title.includes('no-' + changes.status) || (changes.chatSummary && t.title.includes('no-summary')) || ('rank' in changes && t.title.includes('no-rank')))) throw Object.assign(new Error('the tracker is down'), { status: 503 });
    return s.update(p, id, changes);
  } };
}
module.exports = { open };
