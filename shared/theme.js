// The page's colours, Light, Dark or Auto, shared by the room page and the manual. Each page loads this
// in <head>, before its styles, so data-theme is set before the first paint and nothing flashes. Auto is
// the start: no data-theme is set and the CSS follows the computer's own setting. Light or Dark is kept
// in this browser under office.pageTheme, and Auto removes it. When storage is blocked the choice still
// holds until the page is closed. Any button with data-page-theme="light", "dark" or "" (Auto) is a
// switch. The pressed one is the choice, and Auto when there is none.
// Open tabs follow a choice made in another tab. This is the page's colours only: the scene's own light
// (day, evening, night) is the Light control in office.js, and this script never touches it.
// A page that sets its own data-theme before loading this, such as a world shown inside another page,
// keeps it: the stored choice, the switches and other tabs leave it alone.
(function () {
  'use strict';
  var KEY = 'office.pageTheme';
  var root = document.documentElement;
  var fixed = root.getAttribute('data-theme') || '';

  function stored() {
    try { var v = window.localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : ''; } catch (e) { return ''; }
  }
  function system() {
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) { return 'light'; }
  }
  function current() { return root.getAttribute('data-theme') || system(); }
  function show() {
    var on = root.getAttribute('data-theme') || '', buttons = document.querySelectorAll('[data-page-theme]');
    for (var i = 0; i < buttons.length; i++) buttons[i].setAttribute('aria-pressed', String(buttons[i].getAttribute('data-page-theme') === on));
  }
  function apply(v) {
    if (fixed) v = fixed;
    if (v) root.setAttribute('data-theme', v); else root.removeAttribute('data-theme');
    show();
  }
  function keep(v) {
    try {
      if (v) window.localStorage.setItem(KEY, v); else window.localStorage.removeItem(KEY);
      return true;
    } catch (e) { return false; }
  }
  function choose(v) {
    if (fixed || (v !== 'light' && v !== 'dark' && v !== '')) return;
    keep(v);
    apply(v);
  }

  apply(stored());
  document.addEventListener('DOMContentLoaded', show);
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('[data-page-theme]');
    if (b) choose(b.getAttribute('data-page-theme'));
  });
  window.addEventListener('storage', function (e) { if (e.key === KEY || e.key === null) apply(stored()); });

  window.pageTheme = { current: current, choose: choose, key: KEY };
})();
