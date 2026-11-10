// A store whose list takes a moment, as a tracker across a network does, so two calls on one
// ticket overlap and a check that reads before another call writes can be caught.
// SLOW_STORE_UPDATE_MS makes each update wait that long too, so a write still on its way can be caught.
'use strict';
const memory = require('./memory-store.js');
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
function open() {
  const s = memory.open();
  const updateMs = Number(process.env.SLOW_STORE_UPDATE_MS) || 0;
  return { ...s, name: 'slow',
    async list(p) { await wait(150); return s.list(p); },
    async update(...args) { if (updateMs) await wait(updateMs); return s.update(...args); } };
}
module.exports = { open };
