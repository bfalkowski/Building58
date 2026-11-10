// A second ticket store, kept in memory with ids in another style, as a tracker's might be.
// The tests run on it to show that nothing outside a store depends on how the local one works.
'use strict';
function open() {
  const projects = new Map();
  const of = (p) => { if (!projects.has(p)) projects.set(p, []); return projects.get(p); };
  let next = 100;
  return {
    name: 'memory',
    local: true,
    async list(p) { return of(p).map((t) => ({ ...t })); },
    async get(p, id) { const t = of(p).find((x) => x.id === id); return t ? { ...t } : null; },
    async create(p, fields) { const at = new Date().toISOString(), t = { ...fields, id: 'OFFICE-' + next++, createdAt: at, updatedAt: at }; of(p).push(t); return { ...t }; },
    async update(p, id, changes) { const t = of(p).find((x) => x.id === id); if (!t) return null; const { id: _i, createdAt: _c, ...rest } = changes; Object.assign(t, rest, { updatedAt: new Date().toISOString() }); return { ...t }; }
  };
}
module.exports = { open };
