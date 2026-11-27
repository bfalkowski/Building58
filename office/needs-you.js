// The Needs you panel in the front office: how many things wait on the person, and one line for each, from the relay
// (relay/needs-you.js). It reads the list every two seconds, as the huddle bar reads its state. Clicking a line
// opens what it names: the session at its desk, the PR or the failed CI run on GitHub, or the ticket on the Board. A line about
// another relay on the room's state folder has a Stop button, which asks the relay to stop it (relay/old-relays.js).
// A PR Autopilot handed over because its Dev says a finding is a bug has a Fix it button: the person agrees, and
// the relay lifts the push hold and tells the Dev (POST /autopilot/fix, relay/autopilot.js).
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const section = $('needs-you'), count = $('needs-you-count'), empty = $('needs-you-empty'), list = $('needs-you-list');
  const params = new URLSearchParams(location.search);
  const channel = params.get('channel');
  if (!channel || !section) return;

  const base = location.origin + '/channels/' + encodeURIComponent(channel);
  const url = base + '/needs-you';
  const TICKET = /^[\w.-]{1,20}$/;
  const PR = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
  const RUN = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/;
  const onGithub = (u) => !!u && (PR.test(u) || RUN.test(u));
  let drawn = '';

  function open(link) {
    if (link.terminal) {
      const w = window.run && window.run.state().workers.find((x) => x.session && x.session.terminal === link.terminal);
      if (w) window.dispatchEvent(new CustomEvent('office:pick', { detail: { who: w.id, keep: true } }));
    } else if (onGithub(link.url)) window.open(link.url, '_blank', 'noopener');
    else if (link.ticket && TICKET.test(link.ticket)) window.dispatchEvent(new CustomEvent('office:ticket', { detail: { id: link.ticket } }));
  }
  function row(item) {
    const li = document.createElement('li');
    li.dataset.kind = item.kind;
    const link = item.link || {};
    const opens = !!(link.terminal || onGithub(link.url) || (link.ticket && TICKET.test(link.ticket)));
    const b = document.createElement(opens ? 'button' : 'span');
    b.className = 'needs-line';
    b.textContent = item.line;
    if (opens) {
      b.type = 'button';
      b.title = link.terminal ? 'Open the session of ' + item.who : link.url ? (RUN.test(link.url) ? 'Open the failed run on GitHub' : 'Open the PR on GitHub') : 'Show ' + link.ticket + ' on the Board';
      b.addEventListener('click', () => open(link));
    }
    li.append(b);
    if (Number.isInteger(link.stop) && link.stop > 0) {
      const stop = document.createElement('button');
      stop.type = 'button'; stop.className = 'needs-stop'; stop.textContent = 'Stop';
      stop.title = 'Stop the relay with pid ' + link.stop;
      stop.addEventListener('click', () => {
        stop.disabled = true; stop.textContent = 'Stopping';
        fetch(base + '/old-relays/' + link.stop + '/stop', { method: 'POST' })
          .then((r) => r.json()).catch(() => null)
          .then((r) => { stop.textContent = r && r.ok ? 'Stopped' : 'Not stopped'; stop.title = (r && r.message) || stop.title; drawn = ''; read().then(draw); });
      });
      li.append(stop);
    }
    if (Number.isInteger(link.endJob) && link.terminal) {
      const end = document.createElement('button');
      end.type = 'button'; end.className = 'needs-stop'; end.textContent = 'End it';
      end.title = 'End this one stuck command. The session runs on.';
      end.addEventListener('click', () => {
        end.disabled = true; end.textContent = 'Ending';
        fetch(base + '/floor/end-job', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ who: link.terminal, pid: link.endJob }) })
          .then((r) => r.json()).catch(() => null)
          .then((r) => { end.textContent = r && r.ok ? 'Ended' : 'Not ended'; end.title = (r && r.message) || end.title; drawn = ''; read().then(draw); });
      });
      li.append(end);
    }
    if (typeof link.fix === 'string' && link.fix) {
      const fix = document.createElement('button');
      fix.type = 'button'; fix.className = 'needs-stop'; fix.textContent = 'Fix it';
      fix.title = 'You agree with the Dev: the finding must be fixed in this PR. This lifts the push hold, and its Dev is told to fix it.';
      fix.addEventListener('click', () => {
        fix.disabled = true; fix.textContent = 'Sending';
        fetch(base + '/autopilot/fix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: link.fix }) })
          .then((r) => r.json()).catch(() => null)
          .then((r) => { fix.textContent = r && r.ok ? 'Sent to its Dev' : 'Not sent'; fix.title = (r && r.message) || fix.title; drawn = ''; read().then(draw); });
      });
      li.append(fix);
    }
    if (link.review && typeof link.review.from === 'string' && PR.test(link.review.pr) && window.OfficeReviews) {
      const get = document.createElement('button');
      get.type = 'button'; get.className = 'needs-stop'; get.textContent = 'Get a review';
      get.title = 'Start a review of this PR now. It is your own, and the automatic count does not include it.';
      get.addEventListener('click', () => {
        get.disabled = true; get.textContent = 'Starting';
        fetch(base + '/checkouts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: link.review.from, pr: link.review.pr, prompt: window.OfficeReviews.prBrief(link.review.pr), cols: 120, rows: 32 }) })
          .then((r) => r.json()).catch(() => null)
          .then((r) => { get.textContent = r && r.ok ? 'Started' : 'Not started'; get.title = (r && r.message) || get.title; drawn = ''; read().then(draw); });
      });
      li.append(get);
    }
    if (typeof link.done === 'string' && link.done) {
      const done = document.createElement('button');
      done.type = 'button'; done.className = 'needs-stop'; done.textContent = 'Done';
      done.title = 'Move its task to Done. Its ticket goes to done too.';
      done.addEventListener('click', () => {
        done.disabled = true; done.textContent = 'Moving';
        fetch(base + '/tasks/' + encodeURIComponent(link.done) + '/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'done' }) })
          .then((r) => r.json()).catch(() => null)
          .then((r) => { done.textContent = r && r.ok ? 'Moved' : 'Not moved'; done.title = (r && r.message) || done.title; drawn = ''; read().then(draw); });
      });
      li.append(done);
    }
    if (item.ticket && TICKET.test(item.ticket)) {
      const a = document.createElement('a');
      a.href = window.OfficeLinks ? window.OfficeLinks.ticket(item.ticket) : 'board.html?channel=' + encodeURIComponent(channel) + '&ticket=' + encodeURIComponent(item.ticket);
      a.target = '_blank'; a.rel = 'noopener'; a.className = 'needs-ref'; a.textContent = 'Ticket ' + item.ticket; a.title = 'Open ticket ' + item.ticket;
      li.append(a);
    }
    if (item.pr && PR.test(item.pr)) {
      const a = document.createElement('a');
      a.href = item.pr; a.target = '_blank'; a.rel = 'noopener'; a.className = 'needs-ref'; a.textContent = 'PR #' + item.pr.split('/').pop(); a.title = 'Open the PR on GitHub';
      li.append(a);
    }
    return li;
  }
  function draw(s) {
    if (!s || !s.ok) return;
    section.hidden = false;
    const state = JSON.stringify(s.items);
    if (state === drawn) return;
    drawn = state;
    window.dispatchEvent(new CustomEvent('office:needs', { detail: { items: s.items } }));
    count.textContent = String(s.count);
    section.dataset.count = String(s.count);
    empty.hidden = s.count > 0;
    list.textContent = '';
    s.items.forEach((item) => list.append(row(item)));
  }
  const read = () => fetch(url).then((r) => r.json()).catch(() => null);
  read().then((s) => {
    if (!s || !s.ok) return;
    draw(s);
    setInterval(() => read().then(draw), 2000);
  });
})();
