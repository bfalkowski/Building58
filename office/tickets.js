// The Board: tickets from Triage to Done. The relay keeps them (relay/tickets.js), and what a
// card can do comes from there too. Agents' tickets wait in Triage until you approve them here.
// The same script draws the Board on the room page and in its own tab (office/board.html, the
// section with data-full). The rules both draw with are in office/board-model.js.
// The room page gets the Board from the relay on the event stream it already holds (shared/relay.js,
// relay/board-push.js), and asks with GET /tickets only while that stream does not bring it. The tab has
// no room around it, so it gets names from the Floor, not from window.run, and polls: the room page
// already holds the streams a browser allows to one server. Either way a draw replaces only the cards
// whose content changed.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const section = $('board');
  if (!section) return;
  const M = window.BoardModel;
  const readStored = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const writeStored = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
  const full = section.dataset.full === '1';
  const cols = $('board-cols'), form = $('ticket-form'), note = $('ticket-note'), info = $('board-info'), rejectedBox = $('board-rejected'), rejectedList = rejectedBox.querySelector('ol');
  const status = $('board-status'), waitingLine = $('board-waiting');
  const filterText = $('board-filter-text'), filterRepo = $('board-filter-repo'), filterPriority = $('board-filter-priority'), filterLabel = $('board-filter-label');
  const groupPick = $('board-group-by');
  const params = new URLSearchParams(location.search);
  const channel = params.get('channel');
  function problem(text) {
    if (!status) return;
    status.textContent = text || ''; status.hidden = !text;
  }
  if (!channel) {
    if (!full) { section.hidden = true; return; }
    problem('This tab needs the channel of your room in its address. Open it with "Open in its own tab" on the room page\'s Board.');
    form.hidden = true; cols.hidden = true;
    const tools = section.querySelector('.board-tools'); if (tools) tools.hidden = true;
    return;
  }

  const tab = $('board-tab');
  if (tab) tab.href = 'board.html?channel=' + encodeURIComponent(channel);

  const metricsLink = $('metrics-link');
  if (metricsLink) metricsLink.href = 'metrics.html?channel=' + encodeURIComponent(channel);

  const base = location.origin + '/channels/' + encodeURIComponent(channel);
  const url = (p) => base + '/tickets' + p;
  function api(p, body) {
    const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    return fetch(url(p), opt).then((r) => r.text().then((t) => { try { return JSON.parse(t); } catch (e) { return { ok: false, error: 'not_json', message: 'The relay answered with a page, not JSON (' + r.status + '). On the public page your sign-in may have run out: reload it.' }; } }), () => ({ ok: false, error: 'no_answer', message: 'The relay did not answer.' }));
  }
  function floor() {
    return fetch(base + '/floor').then((r) => r.json()).catch(() => null).then((r) => (r && r.ok ? r.sessions : []));
  }
  const POLL_MS = full ? 2000 : 10000;
  const say = (text, bad) => { note.textContent = text || ''; note.dataset.bad = bad ? '1' : ''; };
  const repoIn = $('ticket-repo');
  repoIn.value = readStored('office.taskRepo') || '';

  const STATE_WORDS = { building: 'building', in_review: 'in review', changes_requested: 'changes requested', waiting_on_you: 'waiting on you', done: 'done' };
  const PIPELINE_WORDS = { red: 'pipeline failed', pending: 'pipeline running', none: 'no pipeline', unknown: 'pipeline unknown' };
  function pipelineNote(t) {
    const p = t.task && t.task.pipeline;
    if (!p) return '';
    if (p.waits) return 'waiting on the pipeline: ' + (p.state === 'red' ? 'a check failed' : 'checks are running');
    return PIPELINE_WORDS[p.state] || '';
  }
  const mergedNote = (t) => (t.task && t.task.prMerged && t.task.state !== 'done' ? 'PR merged on GitHub' : '');
  const waitsOnNote = (t) => (t.task && t.task.waitsOn ? 'PR ' + t.task.waitsOn.words : '');
  function button(text, primary, fn) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn' + (primary ? ' primary' : ''); b.textContent = text;
    b.addEventListener('click', () => { b.blur(); fn(); });
    return b;
  }
  async function act(t, verb, body, then) {
    const r = await api('/' + encodeURIComponent(t.id) + '/' + verb, body);
    say(r.ok ? '' : r.message, !r.ok);
    if (r.ok && then) { then(); last = ''; redraw(); }
    refresh();
  }
  const openCards = new Set();
  const editingBase = new Map();
  function baseForm(t) {
    const f = document.createElement('form'); f.className = 'card-actions';
    const input = document.createElement('input'); input.type = 'text'; input.value = editingBase.get(t.id); input.setAttribute('aria-label', 'Base branch for ' + t.id); input.spellcheck = false;
    input.addEventListener('input', () => editingBase.set(t.id, input.value));
    const save = document.createElement('button'); save.type = 'submit'; save.className = 'btn primary'; save.textContent = 'Save';
    f.addEventListener('submit', (ev) => { ev.preventDefault(); act(t, 'edit', { base: input.value }, () => editingBase.delete(t.id)); });
    f.append(input, save, button('Cancel', false, () => { editingBase.delete(t.id); last = ''; redraw(); }));
    return f;
  }
  const editing = new Map();
  const wordsOf = (t) => ({ title: t.title, body: t.body || '', priority: t.priority || 'normal' });
  function editForm(t) {
    const { from, now } = editing.get(t.id);
    const f = document.createElement('form'); f.className = 'card-actions card-edit';
    const title = document.createElement('input'); title.type = 'text'; title.className = 'whole'; title.maxLength = 80; title.value = now.title; title.setAttribute('aria-label', 'Title of ' + t.id);
    const body = document.createElement('textarea'); body.className = 'whole'; body.rows = 6; body.maxLength = 8000; body.value = now.body; body.setAttribute('aria-label', 'Body of ' + t.id);
    const pick = document.createElement('select'); pick.setAttribute('aria-label', 'Priority of ' + t.id + ' in the edit');
    for (const p of M.PRIORITIES) { const o = document.createElement('option'); o.value = p; o.textContent = p; o.selected = p === now.priority; pick.append(o); }
    const keep = () => editing.set(t.id, { from, now: { title: title.value, body: body.value, priority: pick.value } });
    for (const x of [title, body, pick]) x.addEventListener(x === pick ? 'change' : 'input', keep);
    const save = document.createElement('button'); save.type = 'submit'; save.className = 'btn primary'; save.textContent = 'Save';
    f.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const changes = {};
      for (const [k, v] of [['title', title.value], ['body', body.value], ['priority', pick.value]]) if (v !== from[k]) changes[k] = v;
      if (!Object.keys(changes).length) { editing.delete(t.id); last = ''; redraw(); return; }
      act(t, 'edit', changes, () => editing.delete(t.id));
    });
    f.append(title, body, pick, save, button('Cancel', false, () => { editing.delete(t.id); last = ''; redraw(); }));
    return f;
  }
  const editingKind = new Map();
  const kindList = document.createElement('datalist'); kindList.id = 'board-kinds'; section.append(kindList);
  function fillKinds(kinds) {
    const want = Array.isArray(kinds) ? kinds : [];
    if ([...kindList.options].map((o) => o.value).join('\n') === want.join('\n')) return;
    kindList.replaceChildren(...want.map((k) => { const o = document.createElement('option'); o.value = k; return o; }));
  }
  function kindForm(t) {
    const f = document.createElement('form'); f.className = 'card-actions';
    const input = document.createElement('input'); input.type = 'text'; input.value = editingKind.get(t.id); input.setAttribute('list', kindList.id); input.placeholder = 'docs, tests, bug, feature'; input.setAttribute('aria-label', 'Kind of ' + t.id); input.spellcheck = false;
    input.addEventListener('input', () => editingKind.set(t.id, input.value));
    const save = document.createElement('button'); save.type = 'submit'; save.className = 'btn primary'; save.textContent = 'Save';
    f.addEventListener('submit', (ev) => { ev.preventDefault(); act(t, 'edit', { kind: input.value }, () => editingKind.delete(t.id)); });
    f.append(input, save, button('Cancel', false, () => { editingKind.delete(t.id); last = ''; redraw(); }));
    return f;
  }
  const editingLabels = new Map();
  let labelsInUse = [];
  function labelsForm(t) {
    const f = document.createElement('form'); f.className = 'card-actions';
    const input = document.createElement('input'); input.type = 'text'; input.className = 'whole'; input.value = editingLabels.get(t.id); input.setAttribute('aria-label', 'Labels of ' + t.id); input.spellcheck = false;
    input.placeholder = labelsInUse.length ? 'In use: ' + labelsInUse.join(', ') : 'Words with commas between, like flaky, follow-up';
    input.addEventListener('input', () => editingLabels.set(t.id, input.value));
    const save = document.createElement('button'); save.type = 'submit'; save.className = 'btn primary'; save.textContent = 'Save';
    f.addEventListener('submit', (ev) => { ev.preventDefault(); act(t, 'edit', { labels: input.value.split(',').map((x) => x.trim()).filter(Boolean) }, () => editingLabels.delete(t.id)); });
    f.append(input, save, button('Cancel', false, () => { editingLabels.delete(t.id); last = ''; redraw(); }));
    return f;
  }
  const markingReplaced = new Map(), editingShapes = new Map();
  function idsForm(t, edits, label, placeholder, saveText, send) {
    const f = document.createElement('form'); f.className = 'card-actions';
    const input = document.createElement('input'); input.type = 'text'; input.className = 'whole'; input.value = edits.get(t.id); input.setAttribute('aria-label', label); input.placeholder = placeholder; input.spellcheck = false;
    input.addEventListener('input', () => edits.set(t.id, input.value));
    const save = document.createElement('button'); save.type = 'submit'; save.className = 'btn primary'; save.textContent = saveText;
    f.addEventListener('submit', (ev) => { ev.preventDefault(); send(input.value.split(',').map((x) => x.trim()).filter(Boolean), () => edits.delete(t.id)); });
    f.append(input, save, button('Cancel', false, () => { edits.delete(t.id); last = ''; redraw(); }));
    return f;
  }
  const replacedForm = (t) => idsForm(t, markingReplaced, 'Ticket that replaces ' + t.id, 'The ticket that replaces it, like T-12, or leave it empty', 'Mark replaced', (ids, then) => act(t, 'edit', { mark: 'replaced', replacedBy: ids[0] || null }, then));
  const shapesForm = (t) => idsForm(t, editingShapes, 'Tickets ' + t.id + ' shapes', 'Ids with commas between, like T-7, T-9', 'Save', (ids, then) => act(t, 'edit', { shapes: ids }, then));
  const markingDone = new Map();
  function doneForm(t) {
    const f = document.createElement('form'); f.className = 'card-actions';
    const input = document.createElement('input'); input.type = 'url'; input.className = 'whole'; input.value = markingDone.get(t.id); input.placeholder = 'https://github.com/owner/repo/pull/12'; input.setAttribute('aria-label', 'Merged PR for ' + t.id); input.spellcheck = false;
    input.addEventListener('input', () => markingDone.set(t.id, input.value));
    const save = document.createElement('button'); save.type = 'submit'; save.className = 'btn primary'; save.textContent = 'Mark done';
    f.addEventListener('submit', (ev) => { ev.preventDefault(); act(t, 'move', { to: 'done', pr: input.value.trim() }, () => markingDone.delete(t.id)); });
    f.append(input, save, button('Cancel', false, () => { markingDone.delete(t.id); last = ''; redraw(); }));
    return f;
  }
  let found = null, foundUntil = 0, foundTimer = null;
  const FOUND_MS = 3000;
  async function showTicket({ id, at }) {
    if (window.officeFold) window.officeFold.open('board');
    const r = pushed && lastR ? lastR : await api('');
    if (!r.ok) { section.scrollIntoView({ block: 'nearest' }); say(r.message, true); return; }
    const t = r.tickets.find((x) => x.id === id && (!at || x.createdAt === at));
    if (!t) { section.scrollIntoView({ block: 'nearest' }); say(id + ' is not on the Board any more.', true); return; }
    say('');
    if (M.filtering(filters()) && !M.matches(t, filters())) clearFilters();
    found = id; foundUntil = Date.now() + FOUND_MS; openCards.add(id); last = '';
    lastR = r; draw(r);
    if (t.status === 'rejected') rejectedBox.open = true;
    const el = section.querySelector('[data-ticket="' + CSS.escape(id) + '"]');
    if (el) el.scrollIntoView({ block: 'center', inline: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    clearTimeout(foundTimer);
    foundTimer = setTimeout(() => { section.querySelectorAll('[data-found]').forEach((x) => { delete x.dataset.found; }); }, FOUND_MS);
  }
  window.addEventListener('office:ticket', (ev) => showTicket(ev.detail));
  const orderedNote = (t) => (t.orderedBy ? (t.orderedWhat === 'place' ? 'place' : 'priority') + ' set by ' + (t.orderedBy === 'PM' ? 'the PM' : t.orderedBy === 'Lead' ? 'the Lead' : 'you') : '');
  function startedNote(t) {
    if (!t.task || t.task.by !== 'Lead') return '';
    const at = new Date(t.task.startedAt), today = at.toDateString() === new Date().toDateString();
    return isNaN(at) ? 'started by the Lead' : 'started by the Lead ' + (today ? '' : at.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ') + at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function finishedBlockers(t, byId) {
    return (t.blockedBy || []).filter((id) => !t.waitingFor.includes(id) && !t.rejectedBlockers.includes(id)).map((id) => id + (byId.has(id) ? ' done' : ' gone'));
  }
  const PRIORITIES = M.PRIORITIES;
  function orderControls(t, column) {
    const same = column.filter((x) => (x.priority || 'normal') === (t.priority || 'normal'));
    const at = same.findIndex((x) => x.id === t.id), up = same[at - 1], down = same[at + 1];
    const pick = document.createElement('select'); pick.setAttribute('aria-label', 'Priority of ' + t.id);
    for (const p of PRIORITIES) { const o = document.createElement('option'); o.value = p; o.textContent = p; o.selected = p === (t.priority || 'normal'); pick.append(o); }
    pick.addEventListener('change', () => { pick.blur(); act(t, 'edit', { priority: pick.value }); });
    const upB = button('Up', false, () => act(t, 'order', { before: up.id })); upB.disabled = !up; if (up) upB.dataset.past = up.id; upB.setAttribute('aria-label', 'Move ' + t.id + ' up');
    const downB = button('Down', false, () => act(t, 'order', { after: down.id })); downB.disabled = !down; if (down) downB.dataset.past = down.id; downB.setAttribute('aria-label', 'Move ' + t.id + ' down');
    return [pick, upB, downB];
  }
  function card(t, byId, people, column) {
    const li = document.createElement('li'); li.dataset.priority = t.priority; li.dataset.ticket = t.id;
    if (t.id === found && Date.now() < foundUntil) li.dataset.found = '1';
    const d = document.createElement('details'); d.open = openCards.has(t.id);
    d.addEventListener('toggle', () => {
      const k = cardEls.get(t.id);
      if (k && k.el === li) k.look = li.outerHTML;
      if (d.open) { openCards.add(t.id); return; }
      openCards.delete(t.id);
      if (t.id === found) { found = null; last = ''; redraw(); }
    });
    const s = document.createElement('summary'); s.textContent = t.id + ' ' + t.title;
    const body = document.createElement('p'); body.textContent = t.body || 'No details.';
    d.append(s, body);
    if (t.chatSummary) { const c = document.createElement('p'); c.className = 'chat-summary'; c.textContent = t.chatSummary; d.append(c); }
    if (Array.isArray(t.notes) && t.notes.length) {
      const ul = document.createElement('ul'); ul.className = 'ticket-notes'; ul.setAttribute('aria-label', 'Notes from sessions on ' + t.id);
      for (const n of t.notes) { const item = document.createElement('li'); const who = document.createElement('b'); who.textContent = n.by + (n.role ? ' (' + n.role + ')' : '') + ', ' + M.noteTime(n.at) + ': '; item.append(who, document.createTextNode(n.text)); ul.append(item); }
      d.append(ul);
    }
    if (window.officeTicketHistory) d.append(window.officeTicketHistory.render(t));
    li.append(d);
    const meta = document.createElement('small');
    const state = t.status === 'started' && t.task ? t.task.state : '';
    const after = finishedBlockers(t, byId);
    const others = M.alsoWith(people, t.assignee);
    meta.textContent = [(t.priority || 'normal') + ' priority', t.kind ? 'kind ' + t.kind : 'no kind', M.labelsOf(t).length ? 'labels ' + M.labelsOf(t).join(', ') : '', orderedNote(t), t.createdBy, startedNote(t), state ? 'task ' + (STATE_WORDS[state] || state) : '', pipelineNote(t), mergedNote(t), waitsOnNote(t), window.officeTicketHistory ? window.officeTicketHistory.assigneeText(t) : '', others.length ? 'also with ' + others.join(', ') : '', (t.repo || 'no repo').split('/').pop(), t.base ? 'base ' + t.base : '', t.waitingFor.length ? 'waiting for ' + t.waitingFor.join(', ') : '', t.rejectedBlockers.length ? t.rejectedBlockers.join(', ') + ' was rejected' : '', after.length ? 'after ' + after.join(', ') : '', t.status === 'done' && !t.task && t.pr ? 'merged outside the room' : '', t.status === 'ready' && !t.approved ? 'not approved by you, so nothing starts it by itself' : '', (t.shapes || []).length ? 'shapes ' + t.shapes.join(', ') : '', (t.status === 'triage' || t.status === 'ready') && t.heldBack ? t.heldBack : ''].filter(Boolean).join(' · ');
    li.append(meta);
    if (t.writeError) { const w = document.createElement('p'); w.className = 'write-error'; w.setAttribute('role', 'status'); w.textContent = t.writeError; li.append(w); }
    if (t.proposal) {
      const p = document.createElement('p'); p.className = 'proposal'; p.textContent = M.proposalText(t);
      const decide = document.createElement('div'); decide.className = 'card-actions';
      decide.append(button('Approve proposal', true, () => act(t, 'proposal', { decision: 'approve' })), button('Decline proposal', false, () => act(t, 'proposal', { decision: 'decline' })));
      li.append(p, decide);
    }
    const row = document.createElement('div'); row.className = 'card-actions';
    if (t.status === 'started' && !t.task) row.append(button('Start again', true, () => act(t, 'start', {})), button('Back to Ready', false, () => act(t, 'move', { to: 'ready' })));
    if (t.status === 'triage') { row.append(button('Approve', true, () => act(t, 'move', { to: 'ready' })), button('Reject', false, () => act(t, 'move', { to: 'rejected' }))); }
    if (t.status === 'ready') { const go = button('Start', true, () => act(t, 'start', {})); go.disabled = t.waitingFor.length > 0; row.append(go, button('Reject', false, () => act(t, 'move', { to: 'rejected' }))); }
    if (t.status === 'triage' || t.status === 'ready') row.append(...orderControls(t, column || [t]));
    if ((t.status === 'triage' || t.status === 'ready') && !editing.has(t.id)) row.append(button('Edit', false, () => { editing.set(t.id, { from: wordsOf(t), now: wordsOf(t) }); last = ''; redraw(); }));
    if ((t.status === 'triage' || t.status === 'ready') && !editingBase.has(t.id)) row.append(button('Change base', false, () => { editingBase.set(t.id, t.base || ''); last = ''; redraw(); }));
    if ((t.status === 'triage' || t.status === 'ready') && !editingKind.has(t.id)) row.append(button('Change kind', false, () => { editingKind.set(t.id, t.kind || ''); last = ''; redraw(); }));
    if (!editingLabels.has(t.id)) row.append(button('Labels', false, () => { editingLabels.set(t.id, M.labelsOf(t).join(', ')); last = ''; redraw(); }));
    if ((t.status === 'triage' || t.status === 'ready') && t.mark) row.append(button(t.mark === 'hold' ? 'Take off hold' : 'Not replaced', false, () => act(t, 'edit', { mark: null })));
    if ((t.status === 'triage' || t.status === 'ready') && !t.mark) row.append(button('Hold', false, () => act(t, 'edit', { mark: 'hold' })));
    if ((t.status === 'triage' || t.status === 'ready') && !t.mark && !markingReplaced.has(t.id)) row.append(button('Replaced', false, () => { markingReplaced.set(t.id, ''); last = ''; redraw(); }));
    if (['triage', 'ready', 'started'].includes(t.status) && !editingShapes.has(t.id)) row.append(button('Shapes', false, () => { editingShapes.set(t.id, (t.shapes || []).join(', ')); last = ''; redraw(); }));
    if ((t.status === 'triage' || t.status === 'ready') && !markingDone.has(t.id)) row.append(button('Merged elsewhere', false, () => { markingDone.set(t.id, ''); last = ''; redraw(); }));
    const pr = (t.task && t.task.pr) || t.pr;
    if (pr && /^https:\/\/github\.com\//.test(pr)) { const a = document.createElement('a'); a.href = pr; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'PR #' + pr.split('/').pop(); row.append(a); }
    if (row.children.length) li.append(row);
    if ((t.status === 'triage' || t.status === 'ready') && editing.has(t.id)) li.append(editForm(t));
    if ((t.status === 'triage' || t.status === 'ready') && editingBase.has(t.id)) li.append(baseForm(t));
    if ((t.status === 'triage' || t.status === 'ready') && editingKind.has(t.id)) li.append(kindForm(t));
    if (editingLabels.has(t.id)) li.append(labelsForm(t));
    if ((t.status === 'triage' || t.status === 'ready') && markingDone.has(t.id)) li.append(doneForm(t));
    if ((t.status === 'triage' || t.status === 'ready') && !t.mark && markingReplaced.has(t.id)) li.append(replacedForm(t));
    if (['triage', 'ready', 'started'].includes(t.status) && editingShapes.has(t.id)) li.append(shapesForm(t));
    return li;
  }

  const filters = () => ({ text: filterText ? filterText.value : '', repo: filterRepo ? filterRepo.value : '', priority: filterPriority ? filterPriority.value : '', label: filterLabel ? filterLabel.value : '' });
  function clearFilters() { if (filterText) filterText.value = ''; if (filterRepo) filterRepo.value = ''; if (filterPriority) filterPriority.value = ''; if (filterLabel) filterLabel.value = ''; }
  function fillLabels(labels) {
    labelsInUse = Array.isArray(labels) ? labels : [];
    if (!filterLabel) return;
    const have = [...filterLabel.options].slice(2).map((o) => o.value);
    if (labelsInUse.join('\n') === have.join('\n')) return;
    const keep = filterLabel.value;
    filterLabel.length = 2;
    for (const l of labelsInUse) { const o = document.createElement('option'); o.value = l; o.textContent = l; filterLabel.append(o); }
    filterLabel.value = keep === M.NO_LABEL || labelsInUse.includes(keep) ? keep : '';
  }
  const GROUP_BY_KEY = 'office.boardGroupBy';
  if (groupPick && readStored(GROUP_BY_KEY) === 'label') groupPick.value = 'label';
  const groupBy = () => (groupPick && groupPick.value === 'label' ? 'label' : 'priority');
  if (groupPick) groupPick.addEventListener('change', () => { writeStored(GROUP_BY_KEY, groupBy()); last = ''; redraw(); });
  function fillRepos(tickets) {
    if (!filterRepo) return;
    const want = M.repos(tickets), have = [...filterRepo.options].slice(1).map((o) => o.value);
    if (want.join('\n') === have.join('\n')) return;
    const keep = filterRepo.value;
    filterRepo.length = 1;
    for (const r of want) { const o = document.createElement('option'); o.value = r; o.textContent = r.split('/').pop(); o.title = r; filterRepo.append(o); }
    filterRepo.value = want.includes(keep) ? keep : '';
  }
  [filterText, filterRepo, filterPriority, filterLabel].forEach((el) => el && el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', () => { last = ''; redraw(); }));

  let doneAll = false;
  function drawWaiting(waiting) {
    if (full) document.title = (waiting.length ? '(' + waiting.length + ') ' : '') + 'Board';
    if (!waitingLine) return;
    waitingLine.textContent = '';
    waitingLine.hidden = !waiting.length;
    if (!waiting.length) return;
    waitingLine.append(waiting.length + ' waiting on you: ');
    waiting.forEach((t, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'linkish'; b.textContent = t.id + ' ' + t.title;
      b.addEventListener('click', () => showTicket({ id: t.id, at: t.createdAt }));
      waitingLine.append(i ? ', ' : '', b);
    });
  }

  const GROUPS_KEY = 'office.boardGroups';
  let openGroups = new Set();
  try { openGroups = new Set(JSON.parse(readStored(GROUPS_KEY) || '[]')); } catch (e) { openGroups = new Set(); }
  function keepGroup(name, open) {
    if (open) openGroups.add(name); else openGroups.delete(name);
    writeStored(GROUPS_KEY, JSON.stringify([...openGroups]));
  }
  const columnEls = new Map();
  let groupEls = new Map(), cardEls = new Map(), rejectedEls = new Map();
  function kept(had, now, k, fresh) {
    const look = fresh.outerHTML, old = had.get(k);
    const use = old && old.look === look ? old : { el: fresh, look };
    now.set(k, use);
    return use.el;
  }
  function place(parent, nodes) {
    nodes.forEach((n, i) => { const at = parent.children[i]; if (at !== n) parent.insertBefore(n, at || null); });
    while (parent.children.length > nodes.length) parent.lastElementChild.remove();
  }
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
  let shownCards = new Set();
  function groupsBox(colId, box, groups, cards, byId, filtering, more, now, groupsNow) {
    place(box, groups.map((g, i) => {
      const name = colId + ':' + g.key;
      let e = groupEls.get(name);
      if (!e) {
        e = { d: document.createElement('details'), s: document.createElement('summary'), ol: document.createElement('ol'), was: false };
        const d = e.d; d.className = 'group'; d.dataset.group = g.key;
        if (g.priority) d.dataset.priority = g.priority;
        // Setting open below fires toggle too, so only a change from it is yours.
        d.addEventListener('toggle', () => { if (d.open === e.was) return; e.was = d.open; keepGroup(name, d.open); });
      }
      groupsNow.set(name, e);
      const goneTo = g.cards.some((t) => t.id === found && Date.now() < foundUntil);
      const open = openGroups.has(name) || filtering || goneTo;
      if (e.d.open !== open) { e.was = open; e.d.open = open; }
      setText(e.s, g.label + ' (' + g.cards.length + ')');
      place(e.ol, g.cards.map((t) => { const k = shownCards.has(t.id) ? name + '|' + t.id : t.id; shownCards.add(t.id); return kept(cardEls, now, k, card(t, byId, people.get(t.id) || [], cards)); }));
      place(e.d, [e.s, e.ol].concat(more && i === groups.length - 1 ? [more] : []));
      return e.d;
    }));
  }
  function moreButton(e, text) {
    if (!text) return null;
    if (!e.more || e.more.textContent !== text) e.more = button(text, false, () => { doneAll = !doneAll; last = ''; redraw(); });
    return e.more;
  }

  let last = '', lastR = null, people = new Map();
  const using = () => { const a = document.activeElement; return !!a && cols.contains(a) && /^(SELECT|INPUT|TEXTAREA)$/.test(a.tagName); };
  cols.addEventListener('focusout', () => setTimeout(() => { if (!using()) redraw(); }));
  function draw(r) {
    const f = filters();
    const text = JSON.stringify([r.tickets, r.leadStarts, r.leadStartsLeft, [...people], f, doneAll, groupBy()]);
    if (text === last || using()) return;
    last = text;
    const byId = new Map(r.tickets.map((t) => [t.id, t]));
    const shown = r.tickets.filter((t) => M.matches(t, f)), filtering = M.filtering(f);
    const rejected = shown.filter((t) => t.status === 'rejected'), rejectedAll = r.tickets.filter((t) => t.status === 'rejected').length;
    fillRepos(r.tickets);
    fillKinds(r.kinds);
    fillLabels(r.labels);
    drawWaiting(r.tickets.filter(M.waitsOnYou));
    info.textContent = 'Kept in: ' + r.store + ' · up to ' + r.wipLimit + ' building at once, counting Changes requested' + (r.leadStarts ? ' · the Lead starts tickets while fewer than ' + r.leadStarts + ' are building, ' + r.leadStartsLeft + ' more at most' : '');
    const unapproved = r.tickets.filter((t) => t.status === 'ready' && !t.approved);
    if (unapproved.length) {
      const ids = unapproved.map((t) => t.id);
      const b = button('Approve all Ready (' + ids.length + ')', false, async () => {
        if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Press again to approve ' + ids.join(', ') + '. Autopilot may then start any of them'; return; }
        b.disabled = true;
        const out = await api('/approve-ready', { ids });
        say(out.ok ? (out.approved.length ? 'Approved ' + out.approved.join(', ') + '.' : 'Nothing left to approve.') : out.message, !out.ok);
        last = ''; refresh();
      });
      b.title = 'Marks these Ready tickets as approved by you: ' + ids.join(', ') + '. Reject first any you do not want built.';
      info.append(' · ', b);
    }
    const now = new Map(), groupsNow = new Map();
    shownCards = new Set();
    place(cols, M.COLUMNS.map((c) => {
      let e = columnEls.get(c.id);
      if (!e) {
        e = { col: document.createElement('section'), h: document.createElement('h3'), list: document.createElement('ol'), groups: document.createElement('div'), more: null };
        e.col.dataset.col = c.id; e.groups.className = 'groups';
        columnEls.set(c.id, e);
      }
      const all = r.tickets.filter((t) => M.columnOf(t) === c.id), here = all.filter((t) => M.matches(t, f));
      const { cards, hidden } = M.cardsOf(c.id, here, { all: doneAll, keep: found });
      if (here.length) e.col.dataset.some = '1'; else delete e.col.dataset.some;
      setText(e.h, c.label + ' (' + (filtering ? here.length + ' of ' + all.length : all.length) + ')');
      const more = moreButton(e, c.id === 'done' && (hidden || (doneAll && here.length > M.DONE_SHOWN)) ? (hidden ? 'Show ' + hidden + ' older' : 'Show only the latest ' + M.DONE_SHOWN) : '');
      const groups = M.groupsOf(c.id, cards, groupBy());
      if (groups) { groupsBox(c.id, e.groups, groups, cards, byId, filtering, more, now, groupsNow); place(e.col, [e.h, e.groups]); }
      else {
        place(e.list, cards.map((t) => kept(cardEls, now, t.id, card(t, byId, people.get(t.id) || [], cards))));
        place(e.col, [e.h, e.list].concat(more ? [more] : []));
      }
      return e.col;
    }));
    cardEls = now; groupEls = groupsNow;
    const rejectedNow = new Map();
    place(rejectedList, rejected.map((t) => {
      const li = document.createElement('li'); li.textContent = t.id + ' ' + t.title + ' ' + (M.closedText(t) ? '(' + M.closedText(t) + ') ' : ''); li.dataset.ticket = t.id;
      if (t.id === found && Date.now() < foundUntil) li.dataset.found = '1';
      li.append(button('Back to Triage', false, () => act(t, 'move', { to: 'triage' })));
      return kept(rejectedEls, rejectedNow, t.id, li);
    }));
    rejectedEls = rejectedNow;
    rejectedBox.hidden = !rejectedAll;
    rejectedBox.querySelector('summary').textContent = 'Rejected (' + (filtering ? rejected.length + ' of ' + rejectedAll : rejectedAll) + ')';
  }
  const redraw = () => { if (lastR) draw(lastR); };
  function why(r) {
    if (r.error === 'unauthorized') return 'The relay did not accept this tab. Open the tab again from the room page\'s Board.';
    if (r.error === 'no_answer') return 'The relay is not answering. Start it with npm run office. This tab tries again every ' + POLL_MS / 1000 + ' seconds.';
    return r.message || 'The relay could not list the tickets.';
  }
  let pushed = false;
  window.addEventListener('office:stream', (ev) => { pushed = !!(ev.detail && ev.detail.tickets); });
  window.addEventListener('office:tickets', (ev) => {
    const r = ev.detail;
    if (!r || !r.ok) return;
    pushed = true;
    if (section.hidden && !full) section.hidden = false;
    problem('');
    lastR = r; lastSeen = Date.now();
    people = M.peopleOn(r.people);
    draw(r);
  });
  async function refresh() {
    if (pushed) return;
    const r = await api('');
    if (pushed) return;
    if (!r.ok) {
      if (!full) { if (r.error === 'terminal_off') section.hidden = true; return; }
      problem(why(r) + (lastR ? ' What you see is from ' + new Date(lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' : ''));
      return;
    }
    problem('');
    lastR = r; lastSeen = Date.now();
    if (r.tickets.some((t) => t.status === 'started')) people = M.peopleOn(await floor());
    else people = new Map();
    if (!pushed) draw(r);
  }
  let lastSeen = 0;
  const remember = () => { writeStored('office.taskRepo', repoIn.value); };
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const submit = form.querySelector('[type=submit]'); submit.disabled = true;
    const r = await api('', { title: $('ticket-title').value, body: $('ticket-body').value, priority: $('ticket-priority').value, repo: repoIn.value });
    submit.disabled = false;
    if (!r.ok) { say(r.message, true); return; }
    remember();
    if (r.duplicate) { say(r.ticket.id + ' already has that title ' + (r.ticket.base ? 'on ' + r.ticket.base : 'in this repo') + '. What you typed is still here.', true); return; }
    $('ticket-title').value = ''; $('ticket-body').value = '';
    say('Filed ' + r.ticket.id + '.' + ((r.likely || []).length ? ' It looks like ' + r.likely.map((x) => x.id + ' (' + x.title + ', ' + x.status + ')').join(', ') + '. If it is the same work, reject one.' : ''), (r.likely || []).length > 0);
    refresh();
  });
  $('ticket-pm').addEventListener('click', async () => {
    const idea = [$('ticket-title').value, $('ticket-body').value].map((s) => s.trim()).filter(Boolean).join('. ');
    if (!idea) { say('Write the idea first.', true); return; }
    say('Starting the PM…');
    const pm = $('ticket-pm'); pm.disabled = true;
    const r = await api('/ask', { idea, repo: repoIn.value });
    pm.disabled = false;
    if (!r.ok) { say(r.message, true); return; }
    remember();
    $('ticket-title').value = ''; $('ticket-body').value = '';
    say('The PM is on it. Their tickets will wait in Triage for you.');
    for (let i = 0; i < 10; i++) {
      if (window.run) {
        const w = window.run.state().workers.find((p) => p.session && p.session.terminal === r.terminal);
        if (w) { window.dispatchEvent(new CustomEvent('office:pick', { detail: { who: w.id, keep: true } })); break; }
      } else {
        const s = (await floor()).find((x) => x.terminal === r.terminal && x.named);
        if (s) { say('The PM is on it, as ' + s.name + ' in the room. Their tickets will wait in Triage for you.'); break; }
      }
      // eslint-disable-next-line no-restricted-syntax -- polls this page's own state at most 10 times, only to follow the new person; no event says they appeared
      await new Promise((done) => setTimeout(done, 500));
    }
  });
  refresh();
  setInterval(refresh, POLL_MS);
})();
