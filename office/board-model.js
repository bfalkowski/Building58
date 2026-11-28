// The Board's rules that do not touch the page: which column a ticket goes in, what a filter keeps,
// and how much of Done shows. A started ticket is in Waiting on you when the Needs you list names its task
// (needsYou, from relay/needs-you.js), and a task in Waiting on you that it does not name shows where its
// work is. Without needsYou, as from a relay that does not send it, the task's state decides.
// office/tickets.js draws with them, on the room page and on office/board.html, and relay/test/board.test.js
// checks them.
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
    const task = t.status === 'started' ? t.task : null;
    if (task && task.needsYou) return 'waiting_on_you';
    if (task && task.pipeline && task.pipeline.waits) return 'building';
    if (task && task.needsYou === null && task.state === 'waiting_on_you') return task.reviewRuns ? 'in_review' : 'building';
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

  const WHO = { PM: 'The PM', Lead: 'The Lead', you: 'You' };
  function proposalText(t) {
    const p = t.proposal;
    if (!p) return '';
    const ids = (p.ids || []).join(', ');
    const what = p.action === 'replace' ? 'replace ' + t.id + ' with ' + ids : p.action === 'merge' ? 'merge ' + t.id + ' into ' + ids
      : p.action === 'close' ? 'close ' + t.id + (p.commit ? ' as not needed (commit ' + String(p.commit).slice(0, 10) + ')' : '') : 'set the blockers of ' + t.id + ' to ' + (ids || 'none');
    return (WHO[p.by] || 'A session') + (p.by === 'you' ? ' propose' : ' proposes') + ' to ' + what + '.' + (p.why ? ' Why: ' + p.why : '');
  }
  const CLOSED = { replaced: 'replaced by ', merged: 'merged into ' };
  const closedText = (t) => (t.closedAs === 'closed' ? 'closed' : t.closedAs === 'not-needed' ? 'not needed' : CLOSED[t.closedAs] ? CLOSED[t.closedAs] + (t.closedFor || []).join(', ') : '');
  function noteTime(at) {
    const d = new Date(at);
    if (!at || isNaN(d)) return 'time not recorded';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const waitsOnYou = (t) => columnOf(t) === 'waiting_on_you' || !!t.proposal;

  const alsoWith = (names, assignee) => (names || []).filter((n) => !(assignee && assignee.name === n));

  const api = { COLUMNS, DONE_SHOWN, PRIORITIES, GROUP_FROM, NO_LABEL, priorityOf, labelsOf, groupsOf, stateOf, columnOf, matches, filtering, repos, cardsOf, peopleOn, alsoWith, proposalText, closedText, noteTime, waitsOnYou };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BoardModel = api;
})(this);
