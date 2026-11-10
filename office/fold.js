// The room page's Board, Chat and Tasks fold to their header, so the page stays short. Each starts
// closed. Press its title to open or close it. This browser keeps the ones you opened, so they stay
// open after a reload. Other pages open one for a moment with window.officeFold.open(id), such as the
// Board when you go to a ticket from the Floor. That does not keep it open.
(function () {
  'use strict';
  const KEY = 'office.openSections';
  let kept = new Set();
  try { kept = new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch (e) { /* no storage */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify([...kept])); } catch (e) { /* no storage */ } };
  const setters = {};
  for (const id of ['board', 'chat', 'tasks']) {
    const section = document.getElementById(id), h = section && section.querySelector(':scope > header h2');
    if (!h) continue;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'fold'; b.setAttribute('aria-controls', id); b.textContent = h.textContent;
    h.textContent = ''; h.append(b);
    const set = (open, keep) => {
      section.toggleAttribute('data-folded', !open);
      b.setAttribute('aria-expanded', String(open));
      if (!keep) return;
      if (open) kept.add(id); else kept.delete(id);
      save();
    };
    b.addEventListener('click', () => set(section.hasAttribute('data-folded'), true));
    set(kept.has(id), false);
    setters[id] = set;
  }
  window.officeFold = { open: (id) => { if (setters[id]) setters[id](true, false); } };
})();
