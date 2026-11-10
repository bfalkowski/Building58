// The Tasks panel: new tasks, and every task with its state, worker, branch and PR. The relay
// keeps them (relay/tasks.js). Click a task to see its worker. Each task also goes on the board
// on the brick wall, through the "tasks" action.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const section = $('tasks'), rows = $('task-rows'), form = $('task-form'), note = $('task-note');
  const params = new URLSearchParams(location.search);
  const channel = params.get('channel'), key = params.get('key') || '';
  if (!section) return;
  if (!channel) { section.hidden = true; return; }

  const LABEL = { building: 'Building', in_review: 'In review', changes_requested: 'Changes requested', waiting_on_you: 'Waiting on you', done: 'Done' };
  const url = (p) => location.origin + '/channels/' + encodeURIComponent(channel) + '/tasks' + p + '?key=' + encodeURIComponent(key);
  function api(p, body) {
    const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    return fetch(url(p), opt).then((r) => r.json()).catch(() => ({ ok: false, message: 'The relay did not answer.' }));
  }
  const say = (text, bad) => { note.textContent = text || ''; note.dataset.bad = bad ? '1' : ''; };
  const repoIn = $('task-repo');
  try { repoIn.value = localStorage.getItem('office.taskRepo') || ''; } catch (e) { /* no storage */ }

  function workerOf(task) {
    if (!task.worker || !window.run) return null;
    return window.run.state().workers.find((w) => w.session && w.session.terminal === task.worker.terminal) || null;
  }
  let lastDrawn = '', lastTasks = [], selectFocusAt = 0;
  const asking = new Map();  // task id -> the ignored files Clean up would delete
  const SELECT_HOLD = 15000;
  rows.addEventListener('focusin', (ev) => { if (ev.target.tagName === 'SELECT') selectFocusAt = Date.now(); });
  function draw(tasks) {
    const el = document.activeElement;
    if (el && el.tagName === 'SELECT' && el.closest('#task-rows') && Date.now() - selectFocusAt < SELECT_HOLD) return;  // redrawing would close it
    lastTasks = tasks;
    const text = JSON.stringify([tasks, [...asking]]);
    if (text === lastDrawn) return;
    lastDrawn = text;
    rows.textContent = '';
    if (!tasks.length) { const li = document.createElement('li'); li.className = 'task-empty'; li.textContent = 'No tasks yet.'; rows.append(li); return; }
    for (const task of tasks) {
      const li = document.createElement('li'); li.dataset.state = task.state;
      const main = document.createElement('button'); main.type = 'button'; main.className = 'task-main';
      const w = workerOf(task);
      const title = document.createElement('b'); title.textContent = task.title;
      const meta = document.createElement('small');
      meta.textContent = (w ? w.name + ' · ' + w.status : 'no worker') + ' · ' + task.branch + (task.round ? ' · round ' + task.round : '') + (task.briefed === false ? ' · brief not in yet' : '');
      main.append(title, meta);
      const review = reviewLine(task);
      if (review) { const r = document.createElement('small'); r.className = 'task-review'; r.textContent = review; main.append(r); }
      main.title = w ? 'Show ' + w.name + "'s session" : 'This task has no worker right now';
      main.addEventListener('click', () => { main.blur(); if (w) window.dispatchEvent(new CustomEvent('office:pick', { detail: { who: w.id, keep: true } })); });
      li.append(main);
      if (task.pr && /^https:\/\/github\.com\//.test(task.pr)) {
        const a = document.createElement('a'); a.href = task.pr; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'PR #' + task.pr.split('/').pop(); li.append(a);
      }
      const sel = document.createElement('select'); sel.setAttribute('aria-label', 'State of ' + task.title);
      Object.keys(LABEL).forEach((s) => { const o = document.createElement('option'); o.value = s; o.textContent = LABEL[s]; o.selected = s === task.state; sel.append(o); });
      sel.addEventListener('change', async () => { const r = await api('/' + task.id + '/move', { to: sel.value }); sel.blur(); if (!r.ok) { say(r.message, true); lastDrawn = ''; } refresh(); });  // redraw, so a refused move shows the old state
      li.append(sel);
      if (!task.worker && task.state !== 'done') li.append(button('Bring back', () => act(task, 'resume')));
      const ignored = asking.get(task.id);
      if (task.state === 'done' && !task.worker && ignored) {
        const ask = document.createElement('small'); ask.className = 'task-review';
        ask.textContent = 'Its checkout holds files git ignores, and Clean up would delete them: ' + ignored.slice(0, 8).join(', ') + (ignored.length > 8 ? ' and ' + (ignored.length - 8) + ' more' : '');
        main.append(ask);
        li.append(button('Delete them too', () => clean(task, ignored)), button('Keep', () => { asking.delete(task.id); draw(lastTasks); }));
      } else if (task.state === 'done' && !task.worker) li.append(button('Clean up', () => clean(task)));
      rows.append(li);
    }
  }
  // What relay/pr-comments.js is doing with the PR's comments, and the last thing it did.
  function reviewLine(task) {
    const p = task.pipeline;
    if (p && p.waits) return 'Waiting on the pipeline, not on ' + (task.state === 'in_review' ? 'a review' : 'you') + ': ' + (p.state === 'red' ? 'a check failed.' : 'checks are running.');
    const r = task.reviews;
    if (r && r.pending) return r.pending.ended || !task.worker ? 'Review waiting, Dev session has ended. Bring it back to deliver it.' : 'Review waiting until the Dev is idle';
    if (r && r.problem) return 'Cannot check the PR for comments: ' + r.problem + '. Trying again.';
    const last = (task.history || []).filter((h) => h.type === 'review').pop();
    return last ? last.note + ' ' + new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  }
  function button(text, fn) { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = text; b.addEventListener('click', () => { b.blur(); fn(); }); return b; }
  async function act(task, verb) {
    const r = await api('/' + task.id + '/' + verb, {});
    say(r.ok ? '' : r.message, !r.ok);
    refresh();
  }
  // Ignored files go only with a yes that names them. The relay asks again about any new since.
  async function clean(task, ignored) {
    const r = await api('/' + task.id + '/clean', { ignored: ignored || [] });
    asking.delete(task.id);
    if (r.error === 'ignored') { asking.set(task.id, r.ignored); say(''); } else say(r.ok ? 'Removed its checkout. Branch ' + task.branch + ' is still there.' : r.message, !r.ok);
    lastDrawn = '';
    refresh();
  }
  async function refresh() {
    const r = await api('');
    if (!r.ok) { if (r.error === 'terminal_off') section.hidden = true; return; }
    draw(r.tasks);
    if (window.run) window.run.do({ action: 'tasks', source: 'tasks', list: r.tasks.map((t) => ({ id: t.id, title: t.ticket ? t.ticket + ' · ' + t.title : t.title, state: t.state, pipeline: t.pipeline && t.pipeline.waits ? t.pipeline.state : null, who: (workerOf(t) || {}).id || null })) });
  }
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const submit = form.querySelector('[type=submit]'); submit.disabled = true; say('Making a checkout and starting a worker…');
    const r = await api('', { title: $('task-title').value, brief: $('task-brief').value, repo: repoIn.value });
    submit.disabled = false;
    if (!r.ok) { say(r.message, true); return; }
    try { localStorage.setItem('office.taskRepo', repoIn.value); } catch (e) { /* no storage */ }
    $('task-title').value = ''; $('task-brief').value = '';
    say('Started on ' + r.task.branch + '. The brief goes in once the session is ready.');
    refresh();
  });
  refresh();
  setInterval(refresh, 2000);
})();
