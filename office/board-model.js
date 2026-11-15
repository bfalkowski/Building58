// The Board's rules that do not touch the page: which column a ticket goes in, what a filter keeps,
// and how much of Done shows. office/tickets.js draws with them, on the room page and on
// office/board.html, and relay/test/board.test.js checks them.
(function (root) {
  'use strict';
  const COLUMNS = [
    { id: 'triage', label: 'Triage', holds: ['triage'] },
    { id: 'ready', label: 'Ready', holds: ['ready'] },
    { id: 'building', label: 'Building', holds: ['building'] },
    { id: 'in_review', label: 'In review', holds: ['in_review'] },
    { id: 'changes_requested', label: 'Changes requested', holds: ['changes_requested'] },
    { id: 'waiting_on_you', label: 'Waiting on you', holds: ['waiting_on_you'] },
    { id: 'done', label: 'Done', holds: ['done'] },
  ];
  const DONE_SHOWN = 8;
  const PRIORITIES = ['high', 'normal', 'low'];
  const priorityOf = (t) => (PRIORITIES.includes(t.priority) ? t.priority : 'normal');
  const GROUPED = ['triage', 'ready'];
  const GROUP_FROM = 7;

  const stateOf = (t) => (t.status === 'started' ? (t.task ? t.task.state : 'building') : t.status);
  function columnOf(t) {
    if (t.status === 'started' && t.task && t.task.pipeline && t.task.pipeline.waits) return 'building';
    const s = stateOf(t), col = COLUMNS.find((c) => c.holds.includes(s));
    if (col) return col.id;
    return t.status === 'started' ? 'building' : null;
  }

  const labelsOf = (t) => (Array.isArray(t.labels) ? t.labels : []);
  const NO_LABEL = '-';
  function matches(t, f) {
    if (!f) return true;
    const text = String(f.text || '').trim().toLowerCase();
    if (text && ![t.id, t.title, t.body].some((s) => String(s || '').toLowerCase().includes(text))) return false;
    if (f.repo && (t.repo || '') !== f.repo) return false;
    if (f.priority && t.priority !== f.priority) return false;
    if (f.label && (f.label === NO_LABEL ? labelsOf(t).length > 0 : !labelsOf(t).includes(f.label))) return false;
    return true;
  }
  const filtering = (f) => !!(f && (String(f.text || '').trim() || f.repo || f.priority || f.label));
  const repos = (tickets) => [...new Set(tickets.map((t) => t.repo).filter(Boolean))].sort();

  function cardsOf(id, tickets, opts) {
    const o = opts || {};
    if (id !== 'done' || o.all) return { cards: tickets.slice(), hidden: 0 };
    const cards = tickets.filter((t, i) => i < DONE_SHOWN || t.id === o.keep);
    return { cards, hidden: tickets.length - cards.length };
  }

  const GROUP_WORDS = { high: 'High', normal: 'Normal', low: 'Low' };
  function groupsOf(id, cards, by) {
    if (id === 'done') return cards.length ? [{ key: 'all', label: 'Latest', cards }] : null;
    if (!GROUPED.includes(id) || cards.length < GROUP_FROM) return null;
    if (by === 'label') {
      const names = [...new Set(cards.flatMap(labelsOf))].sort();
      return names.map((l) => ({ key: 'label:' + l, label: l, cards: cards.filter((t) => labelsOf(t).includes(l)) }))
        .concat([{ key: 'label:', label: 'No label', cards: cards.filter((t) => !labelsOf(t).length) }]).filter((g) => g.cards.length);
    }
    return PRIORITIES.map((p) => ({ key: p, label: GROUP_WORDS[p], priority: p, cards: cards.filter((t) => priorityOf(t) === p) })).filter((g) => g.cards.length);
  }

  function peopleOn(rows) {
    const on = new Map();
    for (const s of rows || []) {
      if (!s.ticket || s.role === 'reviewer' || !s.named) continue;
      on.set(s.ticket, (on.get(s.ticket) || []).concat(s.name));
    }
    return on;
  }

  const alsoWith = (names, assignee) => (names || []).filter((n) => !(assignee && assignee.name === n));

  const api = { COLUMNS, DONE_SHOWN, PRIORITIES, GROUP_FROM, NO_LABEL, priorityOf, labelsOf, groupsOf, stateOf, columnOf, matches, filtering, repos, cardsOf, peopleOn, alsoWith };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BoardModel = api;
})(this);
