// The chat board: the relay's news in #office, one chat channel per started ticket, and fun ones you
// make. The relay keeps the posts (relay/chat.js). Posting here types nothing into a session, unless
// the post mentions exactly one of them by name, and then only a pointer, once it is idle.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const section = $('chat');
  const params = new URLSearchParams(location.search);
  const channel = params.get('channel'), key = params.get('key') || '';
  if (!section || !channel) return;

  const roomsList = $('chat-rooms'), postsList = $('chat-posts'), title = $('chat-room-title'), about = $('chat-room-about');
  const form = $('chat-form'), text = $('chat-text'), note = $('chat-note'), newForm = $('chat-new'), newName = $('chat-new-name'), del = $('chat-delete');
  const url = (p) => location.origin + '/channels/' + encodeURIComponent(channel) + '/chat' + p + (p.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
  function api(p, body) {
    const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    return fetch(url(p), opt).then((r) => r.json()).catch(() => ({ ok: false, message: 'The relay did not answer.' }));
  }
  const say = (words, bad) => { note.textContent = words || ''; note.dataset.bad = bad ? '1' : ''; };
  const KIND = { office: 'the relay\'s news', ticket: 'a ticket', fun: 'fun' };
  const BY = { relay: 'the relay', person: 'you', session: 'a session' };

  let current = 'office';
  try { current = localStorage.getItem('office.chatRoom') || 'office'; } catch (e) { /* no storage */ }
  let rooms = [], shown = '', shownAt = '', lastN = 0, armed = null;

  let drawnRooms = '';
  function drawRooms() {
    const state = JSON.stringify([current, rooms]);
    if (state === drawnRooms) return;  // a redraw would take focus off a chat channel
    drawnRooms = state;
    roomsList.textContent = '';
    for (const r of rooms) {
      const li = document.createElement('li'); li.dataset.kind = r.kind;
      const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-pressed', String(r.name === current));
      const n = document.createElement('span'); n.textContent = '#' + r.name;
      const s = document.createElement('small'); s.textContent = (r.kind === 'ticket' ? r.title : KIND[r.kind]) + ' · ' + r.posts + (r.posts === 1 ? ' post' : ' posts');
      b.append(n, s);
      b.addEventListener('click', () => pick(r.name));
      li.append(b); roomsList.append(li);
    }
  }
  function postItem(p) {
    const li = document.createElement('li'); li.dataset.by = p.by;
    const t = document.createElement('time'); t.dateTime = p.at; t.textContent = new Date(p.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const body = document.createElement('div');
    const who = document.createElement('b'); who.textContent = p.by === 'person' ? 'you' : p.from; who.title = 'Sent by ' + (BY[p.by] || 'someone');
    body.append(who, document.createTextNode(p.text));
    if (p.mention || p.note) { const e = document.createElement('em'); e.textContent = p.mention ? p.mention + ' will be told once it is idle.' : p.note; body.append(e); }
    li.append(t, body);
    return li;
  }
  function pick(name) {
    current = name; shown = ''; lastN = 0; armed = null; del.textContent = 'Delete';
    try { localStorage.setItem('office.chatRoom', name); } catch (e) { /* no storage */ }
    drawRooms(); loadPosts();
  }
  async function loadPosts() {
    const want = current;
    const fresh = shown !== want;
    const r = await api('/' + encodeURIComponent(want) + (fresh ? '' : '?since=' + lastN));
    if (want !== current) return;
    if (!r.ok) { if (r.error === 'no_chat' && current !== 'office') pick('office'); return; }
    // Deleted and made again between two looks: its posts are numbered from 1 again, so start over.
    if (!fresh && r.room.createdAt !== shownAt) { shown = ''; return loadPosts(); }
    shownAt = r.room.createdAt;
    title.textContent = '#' + r.room.name;
    about.textContent = r.room.about + ' · keeps the newest ' + r.keep;
    const atEnd = postsList.scrollHeight - postsList.scrollTop - postsList.clientHeight < 24;
    if (fresh) { postsList.textContent = ''; shown = want; }
    for (const p of r.posts) { postsList.append(postItem(p)); lastN = p.n; }
    while (postsList.children.length > r.keep) postsList.firstChild.remove();
    if (!postsList.children.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'No posts yet.'; postsList.append(li); }
    else { const e = postsList.querySelector('.empty'); if (e) e.remove(); }
    if (fresh || atEnd) postsList.scrollTop = postsList.scrollHeight;
  }
  async function loadRooms() {
    const r = await api('');
    if (!r.ok) return false;
    rooms = r.rooms;
    if (!rooms.some((x) => x.name === current)) { current = 'office'; shown = ''; }
    drawRooms();
    return true;
  }
  async function refresh() { if (await loadRooms()) await loadPosts(); }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!text.value.trim()) return;
    const r = await api('/' + encodeURIComponent(current), { text: text.value });
    if (!r.ok) { say(r.message, true); return; }
    say(r.post.note || ''); text.value = '';
    refresh();
  });
  newForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('', { name: newName.value });
    if (!r.ok) { say(r.message, true); return; }
    say(''); newName.value = '';
    await loadRooms(); pick(r.room.name);
  });
  // Two presses, so one slip deletes nothing. A ticket's chat channel leaves a short summary on the ticket.
  del.addEventListener('click', async () => {
    if (armed !== current) {
      armed = current;
      const room = rooms.find((x) => x.name === current);
      del.textContent = room && room.kind === 'ticket' ? 'Press again: keeps a summary on ' + room.ticket : 'Press again to delete #' + current;
      return;
    }
    armed = null; del.textContent = 'Delete';
    const r = await api('/' + encodeURIComponent(current) + '/delete', {});
    say(r.ok ? 'Deleted #' + r.removed + '.' : r.message, !r.ok);
    if (r.ok) pick('office');
    refresh();
  });

  // The terminal has to be on, and only the page on this computer gets an answer.
  loadRooms().then((ok) => {
    if (!ok) return;
    section.hidden = false;
    loadPosts();
    setInterval(refresh, 3000);
  });
})();
