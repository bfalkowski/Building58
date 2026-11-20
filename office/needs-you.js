// The Needs you panel on the Floor: how many things wait on the person, and one line for each, from the relay
// (relay/needs-you.js). It reads the list every two seconds, as the huddle bar reads its state. Clicking a line
// opens what it names: the session at its desk, the PR on GitHub, or the ticket on the Board. A line about
// another relay on the room's state folder has a Stop button, which asks the relay to stop it (relay/old-relays.js).
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const section = $('needs-you'), count = $('needs-you-count'), empty = $('needs-you-empty'), list = $('needs-you-list');
  const params = new URLSearchParams(location.search);
  const channel = params.get('channel'), key = params.get('key') || '';
  if (!channel || !section) return;

  const base = location.origin + '/channels/' + encodeURIComponent(channel);
  const url = base + '/needs-you?key=' + encodeURIComponent(key);
  const TICKET = /^[\w.-]{1,20}$/;
  const PR = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
  let drawn = '';

  function open(link) {
    if (link.terminal) {
      const w = window.run && window.run.state().workers.find((x) => x.session && x.session.terminal === link.terminal);
      if (w) window.dispatchEvent(new CustomEvent('office:pick', { detail: { who: w.id, keep: true } }));
    } else if (link.url && PR.test(link.url)) window.open(link.url, '_blank', 'noopener');
    else if (link.ticket && TICKET.test(link.ticket)) window.dispatchEvent(new CustomEvent('office:ticket', { detail: { id: link.ticket } }));
  }
  function row(item) {
    const li = document.createElement('li');
    li.dataset.kind = item.kind;
    const link = item.link || {};
    const opens = !!(link.terminal || (link.url && PR.test(link.url)) || (link.ticket && TICKET.test(link.ticket)));
    const b = document.createElement(opens ? 'button' : 'span');
    b.className = 'needs-line';
    b.textContent = item.line;
    if (opens) {
      b.type = 'button';
      b.title = link.terminal ? 'Open the session of ' + item.who : link.url ? 'Open the PR on GitHub' : 'Show ' + link.ticket + ' on the Board';
      b.addEventListener('click', () => open(link));
    }
    li.append(b);
    if (Number.isInteger(link.stop) && link.stop > 0) {
      const stop = document.createElement('button');
      stop.type = 'button'; stop.className = 'needs-stop'; stop.textContent = 'Stop';
      stop.title = 'Stop the relay with pid ' + link.stop;
      stop.addEventListener('click', () => {
        stop.disabled = true; stop.textContent = 'Stopping';
        fetch(base + '/old-relays/' + link.stop + '/stop?key=' + encodeURIComponent(key), { method: 'POST' })
          .then((r) => r.json()).catch(() => null)
          .then((r) => { stop.textContent = r && r.ok ? 'Stopped' : 'Not stopped'; stop.title = (r && r.message) || stop.title; drawn = ''; read().then(draw); });
      });
      li.append(stop);
    }
    if (item.pr && PR.test(item.pr) && !link.url) {
      const a = document.createElement('a');
      a.href = item.pr; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'PR';
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
