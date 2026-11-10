// The page's colours, Light or Dark, shared by the room page and the manual. Each page loads this in
// <head>, before its styles, so data-theme is set before the first paint and nothing flashes. Until
// someone chooses, no data-theme is set and the CSS follows the computer's own setting. A choice is kept
// in this browser under office.pageTheme. When storage is blocked the choice still holds until the page
// is closed. Any button with data-page-theme="light" or "dark" is a switch, and shows which one is on.
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
  // What the page shows now: the choice, or the computer's setting.
  function current() { return root.getAttribute('data-theme') || system(); }
  function show() {
    var on = current(), buttons = document.querySelectorAll('[data-page-theme]');
    for (var i = 0; i < buttons.length; i++) buttons[i].setAttribute('aria-pressed', String(buttons[i].getAttribute('data-page-theme') === on));
  }
  function apply(v) {
    if (fixed) v = fixed;
    if (v) root.setAttribute('data-theme', v); else root.removeAttribute('data-theme');
    show();
  }
  function choose(v) {
    if (fixed || (v !== 'light' && v !== 'dark')) return;
    try { window.localStorage.setItem(KEY, v); } catch (e) { /* no storage: the choice lasts for this page */ }
    apply(v);
  }

  apply(stored());
  document.addEventListener('DOMContentLoaded', show);
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('[data-page-theme]');
    if (b) choose(b.getAttribute('data-page-theme'));
  });
  window.addEventListener('storage', function (e) { if (e.key === KEY || e.key === null) apply(stored()); });
  try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', show); } catch (e) { /* old browser */ }

  window.pageTheme = { current: current, choose: choose, key: KEY };
})();
