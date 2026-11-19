// A store that goes away for some updates, chosen by the words in the ticket's title.
// A ticket whose title has "goes-missing" is not found once the file FAKE_STORE_GONE names exists,
// as if the store was reset after it started. One whose title has "no-rank" cannot have its rank written,
// and one whose title has "no-prs" cannot have its taskPrs written.
// One whose title has "held" is read slowly, as a tracker across a network is: once the folder
// FAKE_STORE_HOLD holds a file "armed", the next read of it renames that file to "reading" and waits for a file "go".
'use strict';
const fs = require('fs');
const path = require('path');
const memory = require('./memory-store.js');
async function hold() {
  const dir = process.env.FAKE_STORE_HOLD;
  try { fs.renameSync(path.join(dir, 'armed'), path.join(dir, 'reading')); } catch (e) { return; }
  while (!fs.existsSync(path.join(dir, 'go'))) await new Promise((done) => setTimeout(done, 10));
}
function open() {
  const s = memory.open();
  const gone = (t) => t && t.title.includes('goes-missing') && process.env.FAKE_STORE_GONE && fs.existsSync(process.env.FAKE_STORE_GONE);
  return { ...s, name: 'failing', async get(p, id) {
    const t = await s.get(p, id);
    if (t && t.title.includes('held')) await hold();
    return gone(t) ? null : t;
  }, async update(p, id, changes) {
    const t = await s.get(p, id);
    if (t && (t.title.includes('no-' + changes.status) || (changes.chatSummary && t.title.includes('no-summary')) || ('rank' in changes && t.title.includes('no-rank')) || ('taskPrs' in changes && t.title.includes('no-prs')))) throw Object.assign(new Error('the tracker is down'), { status: 503 });
    return s.update(p, id, changes);
  } };
}
module.exports = { open };
