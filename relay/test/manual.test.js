// The manual in docs/manual/ is the one place that describes how the room behaves. These checks keep
// it whole: every page is there, every link in it resolves (files and #anchors), no page has an em
// dash, and no page loads a library. Links from the READMEs into the manual are checked the same way.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MANUAL = path.join(ROOT, 'docs', 'manual');
const PAGES = ['index.html', 'how-it-works.html', 'running.html', 'roles.html', 'relay.html', 'settings.html', 'glossary.html'];

const read = (file) => fs.readFileSync(file, 'utf8');
const ids = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const pages = () => (fs.existsSync(MANUAL) ? fs.readdirSync(MANUAL).filter((f) => f.endsWith('.html')).sort() : []);

// Where a link goes, or null for one that leaves the repo. A folder means its index.html.
function target(from, href) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null;
  const [rest, hash] = href.split('#');
  const rel = rest.split('?')[0];
  let file = rel ? path.resolve(path.dirname(from), decodeURIComponent(rel)) : from;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  return { file, hash: hash || '' };
}

function broken(from, hrefs) {
  const bad = [];
  for (const href of hrefs) {
    const t = target(from, href);
    if (!t) continue;
    if (!t.file.startsWith(ROOT + path.sep) || !fs.existsSync(t.file)) { bad.push(href + ' (no such file)'); continue; }
    if (t.hash && t.file.endsWith('.html') && !ids(read(t.file)).has(t.hash)) bad.push(href + ' (no such id)');
  }
  return bad;
}

test('The manual', async (t) => {
  await t.test('has an index and its six pages', () => {
    for (const p of PAGES) assert.ok(fs.existsSync(path.join(MANUAL, p)), p + ' is missing');
  });

  await t.test('every link in it resolves, to a file and to an id on that page', () => {
    const bad = [];
    for (const p of pages()) {
      const file = path.join(MANUAL, p);
      const hrefs = [...read(file).matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
      bad.push(...broken(file, hrefs).map((b) => p + ': ' + b));
    }
    assert.deepStrictEqual(bad, []);
  });

  await t.test('no page has an em dash', () => {
    const bad = pages().filter((p) => /—|&mdash;|&#8212;|&#x2014;/i.test(read(path.join(MANUAL, p))));
    assert.deepStrictEqual(bad, []);
  });

  await t.test('no page loads a script, a stylesheet or a font from elsewhere', () => {
    const bad = [];
    for (const p of pages()) {
      const html = read(path.join(MANUAL, p));
      for (const m of html.matchAll(/<(script|link)\b[^>]*\s(?:src|href)="([^"]*)"/g)) if (/^(https?:)?\/\//.test(m[2])) bad.push(p + ': ' + m[2]);
      if (/@import|url\(\s*['"]?(https?:)?\/\//.test(html)) bad.push(p + ': @import or url()');
    }
    assert.deepStrictEqual(bad, []);
  });

  await t.test('links into it from the READMEs and the room page resolve', () => {
    const bad = [];
    for (const rel of ['README.md', 'office/README.md', 'RELAY.md']) {
      const file = path.join(ROOT, rel);
      const hrefs = [...read(file).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
      bad.push(...broken(file, hrefs).map((b) => rel + ': ' + b));
    }
    for (const rel of ['office/index.html', 'office/help.html']) {
      const file = path.join(ROOT, rel);
      const hrefs = [...read(file).matchAll(/\shref="([^"]*manual[^"]*)"/g)].map((m) => m[1]);
      assert.ok(hrefs.length > 0, rel + ' links to the manual');
      bad.push(...broken(file, hrefs).map((b) => rel + ': ' + b));
    }
    assert.deepStrictEqual(bad, []);
  });

  await t.test('old help.html anchors are sent to sections that exist', () => {
    const file = path.join(ROOT, 'office', 'help.html');
    const moved = [...read(file).matchAll(/(\w+): '([^']+\.html#[^']+)'/g)].map((m) => '../docs/manual/' + m[2]);
    assert.ok(moved.length > 0, 'help.html maps its old anchors');
    assert.deepStrictEqual(broken(file, moved), []);
  });
});
