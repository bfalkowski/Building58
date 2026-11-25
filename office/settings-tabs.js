// Tabs, search and the count of changed settings in the Settings window. The tabs sit down the left and
// become one menu on a narrow window. The tab last used is kept in this browser. A row with
// data-changed="true" shows the mark, and its tab shows the count. Search matches the label and help
// text of every row on every tab, and opens the first tab with a match when the current one has none.
// The rows and their marks come from office/terminal.js and office/rules.js. The tabs are in
// office/index.html, and relay/test/settings-tabs.test.js checks they match TABS in relay/config.js.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const dialog = $('settings'), tablist = $('set-tabs'), menu = $('set-tab-menu'), search = $('set-search'), said = $('set-search-said'), empty = $('set-empty'), scroller = dialog && dialog.querySelector('.set-scroll');
  if (!dialog || !tablist || !menu || !search || !scroller) return;
  const KEY = 'office.settingsTab';
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  const panels = [...dialog.querySelectorAll('.set-panel')];
  const panelOf = (id) => $('set-panel-' + id);
  let current = 'trust';

  function remember(id) { try { localStorage.setItem(KEY, id); } catch (e) { return false; } return true; }
  function recall() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }

  function show(id, keep) {
    if (!panelOf(id)) return;
    current = id;
    for (const t of tabs) { const on = t.dataset.tab === id; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; }
    for (const p of panels) p.hidden = p.id !== 'set-panel-' + id;
    menu.value = id;
    scroller.scrollTop = 0;
    if (!keep) remember(id);
  }
  function showFor(el) {
    const p = el && el.closest('.set-panel');
    if (p) show(p.id.replace('set-panel-', ''));
  }

  const nameOf = (tab) => tab.querySelector('.set-tab-name').textContent;
  const marked = (panel) => panel.querySelectorAll('.set-row[data-changed="true"]').length;
  function count() {
    for (const t of tabs) {
      const n = marked(panelOf(t.dataset.tab)), badge = t.querySelector('.set-count'), option = menu.querySelector('option[value="' + t.dataset.tab + '"]');
      badge.hidden = !n; badge.textContent = String(n);
      t.setAttribute('aria-label', nameOf(t) + (n ? ', ' + n + ' changed' : ''));
      option.textContent = nameOf(t) + (n ? ' (' + n + ' changed)' : '');
    }
  }

  const available = (row) => { for (let e = row; e && !e.classList.contains('set-panel'); e = e.parentElement) if (e.hidden) return false; return true; };
  const textOf = (row) => [...row.querySelectorAll('label, .set-what')].map((e) => e.textContent).join(' ').toLowerCase();
  function filter() {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const found = {};
    let total = 0;
    for (const p of panels) {
      let n = 0;
      for (const row of p.querySelectorAll('.set-row')) {
        const miss = words.length > 0 && !(available(row) && words.every((w) => textOf(row).includes(w)));
        if (miss) row.dataset.miss = '1'; else delete row.dataset.miss;
        if (!miss && words.length) n++;
      }
      for (const sec of p.querySelectorAll('section')) { if (words.length && !sec.querySelector('.set-row:not([data-miss])')) sec.dataset.miss = '1'; else delete sec.dataset.miss; }
      found[p.id.replace('set-panel-', '')] = n; total += n;
    }
    for (const t of tabs) {
      const gone = words.length > 0 && !found[t.dataset.tab];
      t.hidden = gone; menu.querySelector('option[value="' + t.dataset.tab + '"]').hidden = gone;
    }
    empty.hidden = !(words.length && !total);
    said.textContent = !words.length ? '' : total ? total + (total === 1 ? ' setting matches' : ' settings match') + ' on ' + Object.values(found).filter(Boolean).length + (Object.values(found).filter(Boolean).length === 1 ? ' tab.' : ' tabs.') : 'No setting matches.';
    if (words.length && total && !found[current]) show(Object.keys(found).find((k) => found[k]), true);
  }

  tablist.addEventListener('click', (ev) => { const t = ev.target.closest('[role="tab"]'); if (t) show(t.dataset.tab); });
  menu.addEventListener('change', () => show(menu.value));
  tablist.addEventListener('keydown', (ev) => {
    const open = tabs.filter((t) => !t.hidden), at = open.findIndex((t) => t.dataset.tab === current);
    const to = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: open.length - 1 }[ev.key];
    if (to === undefined || !open.length) return;
    ev.preventDefault();
    const next = open[(to + open.length) % open.length];
    show(next.dataset.tab);
    next.focus();
  });
  search.addEventListener('input', filter);
  search.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && search.value) { ev.stopPropagation(); ev.preventDefault(); search.value = ''; filter(); } });

  new MutationObserver((records) => {
    count();
    if (search.value.trim() && records.some((r) => r.type === 'childList' || r.attributeName === 'data-changed' || r.target.classList.contains('set-row'))) filter();
  }).observe(scroller, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-changed', 'hidden'] });
  new MutationObserver(() => { if (dialog.open) { search.value = ''; filter(); } }).observe(dialog, { attributes: true, attributeFilter: ['open'] });

  const kept = recall();
  show(panelOf(kept) ? kept : 'trust', true);
  count();
  window.settingsTabs = { show, showFor };
})();
