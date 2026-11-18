// The Update button in the room bar: fetches merged changes for the relay's folder
// (relay/update.js). If only page files changed, the folder fast-forwards and the page reloads. If
// the relay's own files changed, the relay waits until no session is in a turn,
// then fast-forwards and restarts, brings every session back, and the page reloads when it answers
// again. If the new relay failed its check and the supervisor went back to the last good commit,
// the page says so. It says so too when the session host speaks an older version of its messages than
// the relay, until the office is stopped and started. While RELAY_ROLLBACK=1, Update goes through the
// merges one at a time, and the bar says which step it is on, such as "Update: 2 of 5, PR 41". Its stop
// button then stops the loop between merges, and a merge that changes only pages reloads the page. A page
// that loads within NOTE_FOR of the end of an update says how it ended.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const btn = $('cc-update'), offBtn = $('cc-update-off'), note = $('cc-update-note');
  const params = new URLSearchParams(location.search);
  const channel = params.get('channel'), key = params.get('key') || '';
  if (!channel || !btn) return;

  const url = location.origin + '/channels/' + encodeURIComponent(channel) + '/update?key=' + encodeURIComponent(key);
  function api(body) {
    const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    return fetch(url, opt).then((r) => r.json().then((j) => Object.assign({ status: r.status }, j)), () => null).catch(() => null);
  }
  function tell(text, bad) { note.textContent = text; note.hidden = !text; note.dataset.bad = bad ? '1' : ''; }

  const BACK_WITHIN = 60 * 1000;
  const LOOK_EVERY = 10 * 1000;
  const NOTE_FOR = 10 * 60 * 1000;
  let timer = null, wentAway = false, run = null, goneSince = 0, reloads = null;
  function waitingWords(u) {
    const named = (l) => (l || []).map((w) => w.title + ' (' + w.why + ')').join(', ');
    const list = named(u.waitingOn);
    if (u.step) {
      const s = u.step;
      const what = u.state === 'restarting' ? 'Restarting the relay on it. Every session comes back.'
        : u.state === 'checking' ? 'The new relay is in. Waiting for its check before the next merge.'
          : u.state === 'stepping' ? 'Putting it in.'
            : 'It changes the relay, so the relay restarts on it when nobody is in a turn. A session at a question stays at it.' + (list ? ' Waiting for: ' + list + '.' : '');
      return 'Update: ' + s.at + ' of ' + s.of + ', ' + s.name + '. ' + what + (s.stopping ? ' It stops after this merge.' : '') + (s.later ? ' ' + s.later + ' more wait for the next Update.' : '');
    }
    if (u.state === 'restarting') return 'Restarting the relay. Every session comes back.';
    return 'Fetched. The relay pulls it and restarts when nobody is in a turn. A session at a question stays at it.' + (list ? ' Waiting for: ' + list + '.' : '');
  }
  function showOff(u) {
    const s = u && u.step;
    offBtn.textContent = s ? 'Stop after this merge' : 'Call off the restart';
    offBtn.hidden = !u || (s ? u.state === 'restarting' || s.stopping : u.state !== 'waiting');
  }
  function follow(u) {
    clearInterval(timer);
    btn.disabled = true; showOff(u || { state: 'waiting' });
    if (u && u.step && reloads === null) reloads = u.step.reloads;
    timer = setInterval(async () => {
      const r = await api();
      if (r && r.run && run && r.run !== run) {
        if (r.update) { tell('The relay is back. Reloading.'); location.reload(); return; }
        wentAway = true;
      }
      if (!r) {
        wentAway = true; offBtn.hidden = true; goneSince = goneSince || Date.now();
        if (Date.now() - goneSince < BACK_WITHIN) tell('Restarting the relay. Every session comes back.');
        else tell('The relay has not come back after a minute. Look at the terminal where it runs for what went wrong. Start it again by hand the way you started it (npm run office, or npm run relay or node relay/server.js), and every session comes back.', true);
        return;
      }
      if (r.ok && r.update) {
        const s = r.update.step;
        if (s && reloads === null) reloads = s.reloads;
        else if (s && s.reloads > reloads) { location.reload(); return; }
        showOff(r.update); tell(waitingWords(r.update)); return;
      }
      clearInterval(timer);
      if (wentAway || (reloads !== null && r.reloads > reloads)) { tell('The relay is back. Reloading.'); location.reload(); return; }
      btn.disabled = false; offBtn.hidden = true;
      tell(r.note || 'The restart was called off. Nothing was pulled, so the relay\'s folder is as it was. Press Update again to wait for the next quiet moment.');
    }, 1000);
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true; tell('Fetching');
    const r = await api({});
    if (!r) { btn.disabled = false; tell('The relay did not answer.', true); return; }
    if (!r.ok) { btn.disabled = r.error === 'updating'; tell(r.message || 'Could not update.', true); if (r.error === 'updating') follow(r.update); return; }
    if (!r.changed) { btn.disabled = false; tell(r.message); return; }
    if (r.reload) { tell(r.message); setTimeout(() => location.reload(), 800); return; }
    if (!r.restart) { btn.disabled = false; tell(r.message); return; }
    run = r.run; tell(waitingWords(r.update)); follow(r.update);
  });
  offBtn.addEventListener('click', async () => { await api({ cancel: true }); });

  api().then((r) => {
    if (!r || r.status === 404 || r.status === 403 || r.status === 401) { btn.hidden = true; return; }
    btn.title = 'git fetch, then git merge --ff-only just before any restart, in ' + r.dir + ', on ' + r.branch;
    run = r.run;
    setInterval(async () => {
      if (btn.disabled) return;
      const u = await api();
      if (!u || btn.disabled) return;
      if (u.run && run && u.run !== run) { location.reload(); return; }
      if (u.update) { tell(waitingWords(u.update)); follow(u.update); }
    }, LOOK_EVERY);
    if (r.update) { tell(waitingWords(r.update)); follow(r.update); return; }
    if (r.note && r.noteAt && Date.now() - r.noteAt < NOTE_FOR) { tell(r.note, !!r.rollback || /failed|stopped/i.test(r.note)); return; }
    const b = r.rollback;
    if (!b && r.host) tell(r.host, true);
    if (b) tell('The new relay on ' + b.failed.slice(0, 7) + ' failed its check: ' + b.why + '. Update went back to ' + b.running.slice(0, 7) + ', the last commit that passed, and the relay runs that now. The relay\'s folder is on that commit, not ' + r.branch + ', so Update pulls nothing until you fix ' + r.branch + ' and check it out there.', true);
  });
})();
