// The page's Light or Dark switch (shared/theme.js), run in a small fake page: each load is a reload
// with the same browser storage. Until T-23's browser tests land, this is where the switch is checked.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'shared', 'theme.js'), 'utf8');

function storage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };

// One page load. own is a data-theme the page set before the script ran. Returns the page's root attributes, its two switch buttons, and a click.
function load({ store, systemDark = false, own }) {
  const attrs = new Map(own ? [['data-theme', own]] : []);
  const root = { getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null), setAttribute: (k, v) => attrs.set(k, String(v)), removeAttribute: (k) => attrs.delete(k) };
  const button = (v) => {
    const a = new Map([['data-page-theme', v]]);
    const b = { getAttribute: (k) => (a.has(k) ? a.get(k) : null), setAttribute: (k, x) => a.set(k, String(x)) };
    b.closest = () => b;
    return b;
  };
  const buttons = [button('light'), button('dark')];
  const on = {};
  const document = { documentElement: root, querySelectorAll: () => buttons, addEventListener: (t, f) => { on[t] = f; } };
  const window = {
    localStorage: { getItem: (k) => store.getItem(k), setItem: (k, v) => store.setItem(k, v), removeItem: (k) => store.removeItem(k) },
    matchMedia: () => ({ matches: systemDark, addEventListener() {} }),
    addEventListener: (t, f) => { on['window.' + t] = f; }
  };
  if (store === blocked) Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
  vm.runInNewContext(SRC, { window, document });
  on.DOMContentLoaded();
  const pressed = () => buttons.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-page-theme'));
  return { theme: () => root.getAttribute('data-theme'), pressed, click: (i) => on.click({ target: buttons[i] }), storage: () => on['window.storage']({ key: 'office.pageTheme' }), api: window.pageTheme };
}

test('the page follows the computer until someone chooses', () => {
  const light = load({ store: storage(), systemDark: false });
  assert.strictEqual(light.theme(), null, 'no data-theme, so the CSS follows the computer');
  assert.deepStrictEqual(light.pressed(), ['light']);
  const dark = load({ store: storage(), systemDark: true });
  assert.strictEqual(dark.theme(), null);
  assert.deepStrictEqual(dark.pressed(), ['dark']);
});

test('a choice is kept across a reload, before the page is drawn', () => {
  const store = storage();
  const first = load({ store, systemDark: false });
  first.click(1);
  assert.strictEqual(first.theme(), 'dark');
  assert.deepStrictEqual(first.pressed(), ['dark']);
  // The reload: data-theme is set as the script runs in <head>, so the first paint has it.
  const again = load({ store, systemDark: false });
  assert.strictEqual(again.theme(), 'dark');
  assert.deepStrictEqual(again.pressed(), ['dark']);
  again.click(0);
  assert.strictEqual(load({ store, systemDark: true }).theme(), 'light', 'Light holds even on a dark computer');
});

test('a stored value that is not light or dark is ignored', () => {
  const store = storage();
  store.setItem('office.pageTheme', 'purple');
  assert.strictEqual(load({ store }).theme(), null);
});

test('with storage blocked the switch still works for this page', () => {
  const page = load({ store: blocked, systemDark: false });
  assert.strictEqual(page.theme(), null);
  page.click(1);
  assert.strictEqual(page.theme(), 'dark');
  assert.strictEqual(page.api.current(), 'dark');
  assert.strictEqual(load({ store: blocked }).theme(), null, 'nothing was kept, and nothing threw');
});

test('a page that sets its own data-theme before the script keeps it, whatever is stored', () => {
  const store = storage();
  store.setItem('office.pageTheme', 'dark');
  const page = load({ store, systemDark: true, own: 'light' });
  assert.strictEqual(page.theme(), 'light', 'the stored Dark does not replace it');
  assert.deepStrictEqual(page.pressed(), ['light']);
  page.click(1);
  assert.strictEqual(page.theme(), 'light', 'a switch does not change it');
  assert.strictEqual(store.getItem('office.pageTheme'), 'dark', 'and the choice kept for other pages is left alone');
  page.storage();
  assert.strictEqual(page.theme(), 'light', 'nor does a choice made in another tab');
});

test('All worlds, every world page, the room, the board tab, help.html and every manual page load the theme before their styles', () => {
  // A world is a folder with a world.json (relay/server.js); its page is the index.html in it.
  const worlds = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, d.name, 'world.json')) && fs.existsSync(path.join(ROOT, d.name, 'index.html')))
    .map((d) => path.join(ROOT, d.name, 'index.html'));
  assert.ok(worlds.length >= 1, 'it finds the world pages');
  assert.ok(worlds.includes(path.join(ROOT, 'office', 'index.html')), 'and the room page is one of them');
  const pages = [path.join(ROOT, 'index.html'), path.join(ROOT, 'office', 'board.html'), path.join(ROOT, 'office', 'help.html')]
    .concat(worlds)
    .concat(fs.readdirSync(path.join(ROOT, 'docs', 'manual')).filter((f) => f.endsWith('.html')).map((f) => path.join(ROOT, 'docs', 'manual', f)));
  for (const p of pages) {
    const html = fs.readFileSync(p, 'utf8');
    const script = html.search(/<script src="[./]*shared\/theme\.js"><\/script>/);
    const style = html.search(/<style>|<link rel="stylesheet"/);
    assert.ok(script > 0 && script < html.indexOf('</head>'), path.relative(ROOT, p) + ' loads shared/theme.js in its head');
    assert.ok(style < 0 || script < style, path.relative(ROOT, p) + ' loads it before its styles');
  }
});
