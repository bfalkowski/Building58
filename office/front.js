// The front office and the workers row, as plain functions of what the relay already says: the Floor's rows
// (GET /floor, relay/floor.js), Needs you (relay/needs-you.js), the Board's tickets (office/tickets.js) and the
// PM's numbers on the Floor's answer. office/front-view.js draws what these return, and relay/test/front.test.js
// checks them in a sandbox with a window of its own. A card or a seat waits on you only when Needs you names it, so the two always agree, and is
// stuck when its desk says stuck. See docs/manual/how-it-works.html#front-office.
(function (root) {
  'use strict';
  const WORKER_DESKS = 6;
  const STUCK_KINDS = ['stuck', 'stuck-job', 'undelivered', 'prompt', 'gone'];
  const SHORT = { merge: 'merge', question: 'a question', permission: 'a permission', 'handed-over': 'handed over', review: 'a review', waiting: 'a look', merged: 'merged', closed: 'closed', desks: 'a free desk', main: 'main is red', claude: 'Claude Code', relay: 'the relay' };
  const VERDICT = {
    start: ['start', 'start', '✓'], first: ['first', 'after', '↓'], 'not-needed': ['no', 'not needed', '✕'],
    duplicate: ['no', 'duplicate', '✕'], 'part-of': ['no', 'part of another ticket', '✕']
  };
  const PRIORITY = { high: 'high', normal: 'normal', low: 'low' };

  const minutesWords = (m) => (m < 60 ? Math.max(1, Math.round(m)) + ' min' : Math.floor(m / 60) + ' h' + (Math.round(m % 60) ? ' ' + Math.round(m % 60) + ' min' : ''));
  const sentence = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const cut = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };

  function needsOf(row, needs) {
    return (needs || []).filter((i) => i && ((row.terminal && i.terminal === row.terminal) || (row.role === 'Dev' && row.ticket && i.ticket === row.ticket && !i.terminal)));
  }
  function reasonOf(row, needs) {
    const d = row.desk || {}, doing = d.doing || {};
    const mine = needsOf(row, needs);
    const stuck = mine.find((i) => STUCK_KINDS.includes(i.kind));
    if (doing.state === 'stuck' && /^stuck job:/.test(doing.words)) return { kind: 'stuck', text: cut(doing.words.replace(/^s/, 'S'), 90) };
    if (doing.state === 'stuck') return { kind: 'stuck', text: 'Stuck: ' + String(doing.words || 'stuck').replace(/^stuck:\s*/i, '') };
    if (stuck) return { kind: 'stuck', text: 'Stuck: ' + cut(stuck.line, 90) };
    if (mine.length && !(d.review && d.review.followUp)) return { kind: 'wait', text: 'Waits on you: ' + (SHORT[mine[0].kind] || cut(mine[0].line, 50)) };
    return null;
  }
  function reviewerSlot(dev, reviewers) {
    const d = dev.desk || {};
    if (reviewers.length) return { live: reviewers[0], word: 'reviews' };
    if (!d.pr) return { live: null, none: 'no reviewer yet', hint: 'starts when the PR opens', word: 'review after PR' };
    const k = d.status && d.status.key;
    const last = k === 'merge' || k === 'merged' || k === 'done' ? 'merge' : k === 'fix' ? 'fix' : d.rounds ? 'posted' : null;
    return { live: null, none: 'reviewer left its desk', hint: last ? 'last verdict: ' + last : 'no verdict yet', word: 'reviewed' };
  }
  function stageOf(dev, reason) {
    const d = dev.desk || {}, col = d.column && d.column.id, k = d.status && d.status.key, rounds = d.rounds || 0;
    if (k === 'merged' || k === 'done' || col === 'done') return 'merged';
    if (d.review && d.review.followUp) return 'waiting for a follow-up review';
    if (col === 'changes_requested' || k === 'fix') return 'changes requested, round ' + (rounds + 1) + ' next';
    if (reason && reason.kind === 'wait') return 'waits on you';
    if (col === 'waiting_on_you') return 'waits on you';
    if (!d.pr) return 'building';
    return 'in review';
  }
  function headerOf(card) {
    const parts = [];
    if (card.reason) parts.push(card.reason.text);
    if (card.ticket) parts.push('Ticket ' + card.ticket);
    else parts.push(card.title);
    if (card.ticket || card.pr || card.stage) parts.push('PR ' + (card.prNumber || 'not started'));
    if (card.stage && !(card.reason && card.reason.kind === 'wait' && card.stage === 'waits on you')) parts.push(card.stage);
    return parts.join(' · ');
  }
  function cardsOf(rows, needs) {
    const live = (rows || []).filter((r) => r && r.desk);
    const reviewersOf = (dev) => live.filter((r) => r.role === 'reviewer' && r.desk.reviewing && r.desk.reviewing.dev && r.desk.reviewing.dev.terminal === dev.terminal);
    const seen = new Set();
    const cards = live.filter((r) => r.role === 'Dev').map((dev) => {
      const reviewers = reviewersOf(dev);
      reviewers.forEach((r) => seen.add(r.terminal));
      const d = dev.desk, reason = reasonOf(dev, needs);
      const card = {
        key: dev.terminal, ticket: dev.ticket || d.ticket || null, title: cut(dev.title || dev.name, 60), pr: d.pr || null, prNumber: d.prNumber || null,
        dev, slot: reviewerSlot(dev, reviewers), rounds: d.rounds || 0, reason, stage: stageOf(dev, reason)
      };
      card.state = reason ? reason.kind : '';
      card.header = headerOf(card);
      return card;
    });
    const extras = live.filter((r) => !['Dev'].includes(r.role) && !r.seat && !seen.has(r.terminal)).map((r) => {
      const reason = reasonOf(r, needs);
      return { key: r.terminal, row: r, reason, state: reason ? reason.kind : '', header: (reason ? reason.text + ' · ' : '') + (r.role === 'reviewer' ? 'Reviewer of PR ' + (r.desk.prNumber || 'unknown') : r.role) };
    });
    return { cards, extras };
  }
  function proposalsOf(tickets) {
    return (tickets || []).filter((t) => t.proposal && ['triage', 'ready'].includes(t.status)).map((t) => {
      const p = t.proposal, ids = (p.ids || []).join(', ');
      return (p.action === 'close' ? 'close ' + t.id + '?' : p.action === 'merge' ? 'merge ' + t.id + ' into ' + ids + '?' : p.action === 'replace' ? 'replace ' + t.id + ' with ' + ids + '?' : 'change the blockers of ' + t.id + '?');
    });
  }
  const SEAT_ROLE = { lead: 'Lead', pm: 'PM', manager: 'Manager' };
  const clock = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  function managerOf(m) {
    if (!m) return { rung: '', lines: [] };
    const lines = [];
    lines.push(m.lastLowered ? 'Lowered the trust level from ' + m.lastLowered.from + (m.lastLowered.to === null ? '' : ' to ' + m.lastLowered.to) + ' at ' + clock(m.lastLowered.at) + '.' : m.lowersTrust ? 'It has not lowered the trust level.' : 'It may not lower the trust level.');
    if (m.watching) lines.push('Watching: ' + m.watching.label + ' jams, ticket ' + m.watching.ticket + '. ' + (m.watching.outcome ? m.watching.outcome.words : m.watching.fixed ? 'The ticket is done.' : 'The ticket is not done yet.'));
    return { rung: m.level === null || m.level === undefined ? 'trust: no level' : 'trust: ' + m.level + (m.levelName ? ' ' + m.levelName : ''), lines };
  }
  function cooOf(m) {
    const coo = m && m.coo;
    return { running: !!(coo && coo.running), last: coo && coo.last ? 'Last COO report ' + clock(coo.last) + '.' : 'No COO report yet.' };
  }
  function seatOf(kind, rows, needs, tickets, pm, manager) {
    const row = (rows || []).find((r) => r.seat === kind) || null;
    const proposals = kind === 'pm' ? proposalsOf(tickets) : [];
    if (!row) {
      const empty = { kind, role: SEAT_ROLE[kind] || 'Lead', row: null, state: '', dot: 'idle', name: '', doing: 'Not running. The room starts it.', next: '', reason: null };
      if (kind === 'manager') { const m = managerOf(manager); Object.assign(empty, { rung: m.rung, lines: m.lines, coo: cooOf(manager) }); }
      return empty;
    }
    const d = row.desk || {}, doing = (d.doing || {}).state;
    const reason = reasonOf(row, needs);
    const seat = {
      kind, role: row.role, row, name: row.name, terminal: row.terminal, reason, state: reason ? reason.kind : '',
      dot: reason && reason.kind === 'stuck' ? 'err' : doing === 'working' ? 'work' : doing === 'waiting' || (reason && reason.kind === 'wait') ? 'wait' : 'idle',
      doing: cut((d.doing && d.doing.words ? sentence(d.doing.words) : 'Idle') + (row.title && row.title !== row.role ? '. ' + row.title : ''), 140),
      next: d.next ? d.next.text : '', proposal: proposals.length ? 'Proposal: ' + proposals[0] + (proposals.length > 1 ? ' (+' + (proposals.length - 1) + ' more)' : '') : ''
    };
    if (kind === 'manager') {
      const m = managerOf(manager);
      seat.rung = m.rung; seat.lines = m.lines; seat.coo = cooOf(manager);
    }
    if (kind === 'pm' && pm) {
      seat.rung = pm.trustName ? 'trust: ' + pm.trust + ' ' + pm.trustName : '';
      seat.sort = pm.sortHours > 0 && pm.trust > 0 ? (pm.nextSortAt ? 'Next sort in ' + minutesWords(Math.max(1, (Date.parse(pm.nextSortAt) - pm.now) / 60000)) + '.' : 'Sorts every ' + pm.sortHours + ' h.') : 'It does not sort the Board.';
    }
    return seat;
  }
  function verdictOf(t) {
    const steps = (t.history || []).filter((x) => x && x.stage === 'pm-advice');
    const v = steps[steps.length - 1];
    if (t.proposal) {
      const p = t.proposal;
      return { key: 'no', mark: '✕', words: p.action + (p.ids && p.ids.length ? ' ' + p.ids.join(', ') : '') + ' proposed, waits on you', why: p.why || '', you: true };
    }
    if (!v || !VERDICT[v.answer]) return { key: 'none', mark: '', words: 'not checked yet', why: '', you: false };
    const [key, words, mark] = VERDICT[v.answer];
    const named = v.answer === 'first' ? ' ' + v.of : v.of ? ' ' + v.of : '';
    return { key, mark, words: words + (v.answer === 'start' || v.answer === 'not-needed' ? '' : named), why: v.why || '', you: false };
  }
  function upNext(tickets, limit) {
    const ready = (tickets || []).filter((t) => t.status === 'ready');
    const startable = ready.filter((t) => t.repo && t.approved && !(t.waitingFor || []).length && !t.task && (!t.heldBack || t.proposal));
    const shown = startable.slice(0, limit || 5).map((t, i) => ({ n: i + 1, id: t.id, title: cut(t.title, 90), priority: PRIORITY[t.priority] || 'normal', verdict: verdictOf(t) }));
    return { items: shown, more: Math.max(0, ready.length - shown.length) };
  }
  function todayOf(metrics, needsCount, rows) {
    const n = metrics && metrics.numbers ? metrics.numbers : null;
    const workers = (rows || []).filter((r) => !r.seat && r.role !== 'PM' && r.role !== 'Manager').length;
    return { merged: n ? n.merged : null, median: n && n.medianMinutes ? minutesWords(n.medianMinutes) : null, waiting: needsCount, free: Math.max(0, WORKER_DESKS - workers), desks: WORKER_DESKS };
  }
  const SLUG = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/;
  function repoSlug(urls) {
    for (const u of urls || []) { const m = SLUG.exec(String(u || '')); if (m) return m[1]; }
    return null;
  }
  function ticketHref(id, store, slug, channel) {
    if (store === 'github' && slug && /^\d+$/.test(String(id))) return 'https://github.com/' + slug + '/issues/' + id;
    return 'board.html?channel=' + encodeURIComponent(channel) + '&ticket=' + encodeURIComponent(id);
  }

  const api = { cardsOf, seatOf, managerOf, cooOf, upNext, todayOf, verdictOf, proposalsOf, reasonOf, headerOf, stageOf, ticketHref, repoSlug, minutesWords, WORKER_DESKS };
  root.OfficeFront = api;
})(window);
