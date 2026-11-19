// Likely duplicates (T-202): the open tickets of the same repo that look like the same work as a
// ticket being filed. Each ticket becomes a set of words from its title, and one from its title and
// body together, without small common words. Two tickets match by the larger share of words they
// have in common (shared words over all words, for either set), when that share is at least
// MIN_SHARE and they share at least MIN_WORDS words. The best MAX_TWINS come back, closest first.
// It only warns: filing goes ahead. See docs/manual/roles.html#likely-duplicates.
'use strict';
const OPEN = ['triage', 'ready', 'started'];
const MIN_SHARE = 0.4, MIN_WORDS = 2, MAX_TWINS = 3;
const SMALL = new Set(('a an and are as at be but by can do does for from has have if in into is it its make '
  + 'no not of on or so that the then this to was when which who will with fix add').split(' '));

function words(text) {
  const out = new Set();
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9._-]+/)) {
    let w = raw.replace(/^[._-]+|[._-]+$/g, '');
    if (w.length < 2 || SMALL.has(w)) continue;
    if (/^[a-z]{4,}s$/.test(w) && !w.endsWith('ss')) w = w.slice(0, -1);
    out.add(w);
  }
  return out;
}
function share(a, b) {
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  const all = a.size + b.size - both;
  return { both, share: all ? both / all : 0 };
}
const sets = (t) => { const title = words(t.title); return { title, all: new Set([...title, ...words(t.body)]) }; };

function likelyTwins(ticket, tickets) {
  const me = sets(ticket);
  const found = [];
  for (const t of tickets) {
    if (t.id === ticket.id || t.repo !== ticket.repo || !OPEN.includes(t.status)) continue;
    const them = sets(t), byTitle = share(me.title, them.title), byAll = share(me.all, them.all);
    const best = byTitle.share >= byAll.share ? byTitle : byAll;
    if (best.share >= MIN_SHARE && best.both >= MIN_WORDS) found.push({ score: best.share, t });
  }
  return found.sort((x, y) => y.score - x.score).slice(0, MAX_TWINS).map(({ t }) => ({ id: t.id, title: t.title, status: t.status }));
}

module.exports = { likelyTwins, MIN_SHARE, MIN_WORDS, MAX_TWINS };
