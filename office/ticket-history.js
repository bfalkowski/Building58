// Who has a ticket now, and who did what on it, as the relay keeps it (relay/ticket-history.js). This
// only draws: give it a ticket from GET /tickets. The Board (office/tickets.js) uses it, and so can any
// other view of a ticket. A session that is running opens in the panel (office/terminal.js listens for
// office:session). There is no web page for a local session, so nothing here is a link to one.
(function () {
  'use strict';
  const ROLES = { dev: 'Dev', reviewer: 'reviewer', pm: 'PM', lead: 'Lead', coo: 'COO', you: 'you' };
  const STATES = { triage: 'Triage', ready: 'Ready', rejected: 'Rejected', started: 'Started', building: 'Building', changes_requested: 'Changes requested', in_review: 'In review', waiting_on_you: 'Waiting on you', done: 'Done' };
  const BY = { you: 'you', Lead: 'the Lead', relay: 'the relay', Autopilot: 'Autopilot', 'automatic review': 'an automatic review' };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // "Priya, Dev", or the role alone when the page never named that session.
  function personOf(x) {
    const role = ROLES[x.role] || x.role || '';
    if (x.role === 'you') return 'You';
    return x.name ? x.name + (role ? ', ' + role : '') : (role ? role.charAt(0).toUpperCase() + role.slice(1) : 'A session') + ' with no name recorded';
  }
  const ended = (s) => s && !s.running;
  // For a card's one line: who has it now.
  function assigneeText(t) {
    const a = t.assignee;
    if (!a) return 'Unassigned';
    return 'with ' + personOf(a) + (ended(a.session) ? ' (session ended)' : '');
  }
  // Who took a step: you, the Lead, Autopilot, or a session, with the name the page gave it if there is one.
  function byText(x) {
    const by = BY[x.by] || x.by;
    if (!by) return 'someone not recorded';
    return x.name && x.by !== 'you' ? x.name + ' (' + by + ')' : by;
  }
  function stepText(x) {
    switch (x.stage) {
      case 'filed': return 'Filed by ' + byText(x);
      case 'approved': return 'Approved by ' + byText(x);
      case 'started': return 'Started by ' + byText(x);
      case 'dev': return 'Dev: ' + (x.name || 'no name recorded');
      case 'reviewer': return 'Reviewer: ' + (x.name || 'no name recorded') + (x.by === 'you' ? ', started by you' : x.by ? ', ' + (BY[x.by] || x.by) : '');
      case 'edited': return 'Edited' + (x.what && x.what.length ? ' (' + x.what.join(', ') + ')' : '') + ' by ' + byText(x);
      case 'moved': return 'Moved from ' + (STATES[x.from] || x.from) + ' to ' + (STATES[x.to] || x.to) + ' by ' + byText(x);
      default: return x.stage;
    }
  }
  function when(at) {
    if (!at) return 'time not recorded';
    const d = new Date(at);
    if (isNaN(d)) return 'time not recorded';
    const today = d.toDateString() === new Date().toDateString();
    return (today ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ') + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function copyButton(text) {
    const b = el('button', 'btn', 'Copy id'); b.type = 'button';
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch (e) { b.textContent = 'Select the id to copy it'; }
      setTimeout(() => { b.textContent = 'Copy id'; }, 1500);
    });
    return b;
  }
  // The session's full id and folder, which Resume needs, and whether it can be opened or brought back.
  function sessionBlock(s) {
    const box = el('div', 'th-session');
    const id = el('code', null, s.sessionId), folder = el('code', null, s.cwd || 'folder not recorded');
    box.append('Session ', id, ' ', copyButton(s.sessionId), ' in ', folder, ' ');
    if (s.running && s.terminal && !window.run) box.append(el('span', null, 'It is running. Open it from the room page, which has the terminal.'));  // the Board in its own tab
    else if (s.running && s.terminal) {
      const open = el('button', 'btn', 'Open its terminal'); open.type = 'button';
      open.addEventListener('click', () => window.dispatchEvent(new CustomEvent('office:session', { detail: { terminal: s.terminal } })));
      box.append(open);
    } else if (s.folderGone) box.append(el('span', null, 'It has ended, and cannot come back: its folder is gone.'));
    else if (s.cwd) box.append(el('span', null, 'It has ended. To bring it back, put this id in Resume, with this folder.'));
    else box.append(el('span', null, 'It has ended.'));
    return box;
  }
  // For a ticket's detail: who has it now, then each step, oldest first.
  function render(t) {
    const box = el('div', 'ticket-history');
    const now = el('p', 'th-now');
    now.append(el('b', null, t.assignee ? 'Has it now: ' : 'Unassigned'), t.assignee ? personOf(t.assignee) + (ended(t.assignee.session) ? '. That session has ended.' : '') : '');
    box.append(now);
    const steps = t.history || [];
    if (!steps.length) return box;
    const ol = el('ol', 'th-steps');
    for (const x of steps) {
      const li = el('li');
      li.append(el('span', 'th-when', when(x.at)), ' ', el('span', null, stepText(x)));
      if (x.session) li.append(sessionBlock(x.session));
      ol.append(li);
    }
    box.append(ol);
    if (steps.some((x) => x.old)) box.append(el('small', null, 'Some steps are from before histories were kept, so they show only what the ticket and task recorded.'));
    return box;
  }
  window.officeTicketHistory = { render, assigneeText };
})();
