// The Board's rules that do not touch the page: which column a ticket goes in, what a filter keeps,
// and how much of Done shows. office/tickets.js draws with them, on the room page and on
// office/board.html, and relay/test/board.test.js checks them.
(function (root) {
  'use strict';
  // The columns, in order, and what each holds: a ticket's status, or for a started ticket its task's
  // state (relay/tasks.js). To give a new task state a column, add it to one list here.
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
  // A ticket's priority, as the relay orders it (relay/ticket-order.js): none or an unknown one is normal.
  const priorityOf = (t) => (PRIORITIES.includes(t.priority) ? t.priority : 'normal');
  // Triage and Ready can grow long, so from GROUP_FROM cards on they fold into one group per priority,
  // closed until you open one. Shorter columns, and the other columns, show every card.
  const GROUPED = ['triage', 'ready'];
  const GROUP_FROM = 7;

  // What decides the column: the task's state for a started ticket (building until its task exists),
  // or the ticket's status.
  const stateOf = (t) => (t.status === 'started' ? (t.task ? t.task.state : 'building') : t.status);
  // The column's id. A started ticket whose task is in a state no column holds goes in Building, and
  // its card names the state. Rejected is not a column, so it gets null. A task in review or waiting on
  // you whose pipeline is running or failed is not ready for either (relay/tasks.js sets waits), so
  // its card stays in Building and says it waits on the pipeline.
  function columnOf(t) {
    if (t.status === 'started' && t.task && t.task.pipeline && t.task.pipeline.waits) return 'building';
    const s = stateOf(t), col = COLUMNS.find((c) => c.holds.includes(s));
    if (col) return col.id;
    return t.status === 'started' ? 'building' : null;
  }

  // A ticket's labels (relay/tickets.js), or none.
  const labelsOf = (t) => (Array.isArray(t.labels) ? t.labels : []);
  // The label filter's value for tickets with no label.
  const NO_LABEL = '-';
  // A filter keeps a ticket when every part matches: text found in its id, title or body (any case),
  // the same repo folder, the same priority, and the label among its labels (NO_LABEL: it has none).
  // An empty part matches everything.
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
  // The repo folders on the Board, for the repo filter.
  const repos = (tickets) => [...new Set(tickets.map((t) => t.repo).filter(Boolean))].sort();

  // One column's cards, in the order the relay sent them: the Board's order (relay/ticket-order.js,
  // T-42), which ticket.js list shows too, with Done latest first. Done shows its first DONE_SHOWN
  // unless all are asked for, plus one you jumped to. Returns the cards and how many Done cards it
  // left out.
  function cardsOf(id, tickets, opts) {
    const o = opts || {};
    if (id !== 'done' || o.all) return { cards: tickets.slice(), hidden: 0 };
    const cards = tickets.filter((t, i) => i < DONE_SHOWN || t.id === o.keep);
    return { cards, hidden: tickets.length - cards.length };
  }

  // A column's folded groups, each { key, label, cards }, closed until you open one. Done is one
  // group of the cards it shows, whatever their number. Triage and Ready, from GROUP_FROM cards on,
  // are one group per priority (with its priority), high first, each in the order it came, and only
  // the priorities they have. With by 'label' they are one group per label instead, A to Z, then
  // No label: a ticket with several labels is in the group of each, so the same card can show more
  // than once. null when the column shows every card.
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

  // Who is on each ticket, from the Floor's rows (relay/floor.js): ticket id to names. Only people the
  // room page has seated (named), so a card never shows a fallback name. Reviewers are not on it.
  function peopleOn(rows) {
    const on = new Map();
    for (const s of rows || []) {
      if (!s.ticket || s.role === 'reviewer' || !s.named) continue;
      on.set(s.ticket, (on.get(s.ticket) || []).concat(s.name));
    }
    return on;
  }

  // The seated people on a ticket that its assignee (T-24, relay/ticket-history.js) does not already
  // name, so a card never names someone twice.
  const alsoWith = (names, assignee) => (names || []).filter((n) => !(assignee && assignee.name === n));

  const api = { COLUMNS, DONE_SHOWN, PRIORITIES, GROUP_FROM, NO_LABEL, priorityOf, labelsOf, groupsOf, stateOf, columnOf, matches, filtering, repos, cardsOf, peopleOn, alsoWith };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BoardModel = api;
})(this);
