'use strict';
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const { relay, until, ROOT } = require('./helpers.js');

// With the room hooks in ~/.claude/settings.json, the panel adds no hooks of its own, so the hook
// learns its channel only from OFFICE_CHANNEL. Before T-28 the relay never set it, and the hook fell
// back to room, so a session started on another channel worked at a desk in the room channel.
test('a session started from a page reports to that page channel', async (t) => {
  // OFFICE_CHANNEL in the relay's own environment must not reach the session.
  const R = await relay({ OFFICE_CHANNEL: 'office' }); t.after(R.stop);
  fs.mkdirSync(path.join(R.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(R.home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /x/relay/office-hook.js' }] }] } }));
  const call = async (channel, method, p, body) => {
    const r = await fetch('http://127.0.0.1:' + R.port + '/channels/' + channel + p, { method, headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const screen = async (channel, id) => {
    const ctl = new AbortController();
    const r = await fetch('http://127.0.0.1:' + R.port + '/channels/' + channel + '/terminals/' + id + '/stream', { headers: { Authorization: 'Bearer test-key' }, signal: ctl.signal });
    let text = '';
    const reader = r.body.getReader(), dec = new TextDecoder();
    setTimeout(() => ctl.abort(), 300);
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); } } catch (e) { /* cut off on purpose */ }
    return [...text.matchAll(/event: out\ndata: "([^"]+)"/g)].map((m) => Buffer.from(m[1], 'base64').toString()).join('');
  };
  const a = await call('my-project', 'POST', '/terminals', { cwd: R.home });
  assert.strictEqual(a.status, 201, JSON.stringify(a.body));
  const out = await until(async () => { const s = await screen('my-project', a.body.id); return s.includes('office channel:') && s; }, 'the session');
  assert.match(out, /office channel: my-project\r?\n/);
  // Its --settings has only the room's status line (relay/status-line.js), which says how full its context is.
  assert.doesNotMatch(out, /"hooks"/, 'with the hooks installed globally the panel adds none of its own');
  assert.match(out, /--settings \{"statusLine":/);
});

// T-115: npm run office:hooks run inside a panel session took OFFICE_CHANNEL from the panel, and pinned
// the global hooks to that page's channel, so every session from then on reported there. The panel
// marks its channel with OFFICE_PANEL_CHANNEL, and --install leaves that one out. --channel picks one.
test('office:hooks run inside a panel session does not pin that session channel', async (t) => {
  const R = await relay(); t.after(R.stop);
  const r = await fetch('http://127.0.0.1:' + R.port + '/channels/my-project/terminals', { method: 'POST', headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: R.home }) });
  const a = await r.json();
  assert.strictEqual(r.status, 201, JSON.stringify(a));
  const ctl = new AbortController();
  const s = await fetch('http://127.0.0.1:' + R.port + '/channels/my-project/terminals/' + a.id + '/stream', { headers: { Authorization: 'Bearer test-key' }, signal: ctl.signal });
  let text = '';
  const reader = s.body.getReader(), dec = new TextDecoder();
  setTimeout(() => ctl.abort(), 300);
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); } } catch (e) { /* cut off on purpose */ }
  const out = [...text.matchAll(/event: out\ndata: "([^"]+)"/g)].map((m) => Buffer.from(m[1], 'base64').toString()).join('');
  // What the panel gave the session, as a shell in it would pass on to npm run office:hooks.
  const given = (name) => { const m = out.match(new RegExp(name + ': (\\S+)\\r?\\n')); assert.ok(m, out); return m[1] === 'none' ? undefined : m[1]; };
  const inherited = { OFFICE_CHANNEL: given('office channel'), OFFICE_PANEL_CHANNEL: given('office panel channel') };
  assert.strictEqual(inherited.OFFICE_CHANNEL, 'my-project');

  const home = fs.mkdtempSync(path.join(R.home, 'install-'));
  const settings = path.join(home, '.claude', 'settings.json');
  const install = (env, args) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^OFFICE_|^RELAY_/.test(k)));
    const p = spawnSync('node', [path.join(ROOT, 'relay', 'office-hook.js'), '--install'].concat(args || []), { env: Object.assign(clean, { HOME: home, OFFICE_RELAY_KEY: 'k' }, env), encoding: 'utf8' });
    assert.strictEqual(p.status, 0, p.stderr);
    return { said: p.stdout + p.stderr, command: JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.Stop[0].hooks[0].command };
  };

  let got = install(inherited);
  assert.doesNotMatch(got.command, /OFFICE_CHANNEL/, 'the hooks report to the default channel, not the panel session one');
  assert.match(got.said, /channel office\./);
  assert.match(got.said, /--channel/, 'it says how to pick a channel');
  // --channel picks one, here or anywhere.
  got = install(inherited, ['--channel', 'my-project']);
  assert.match(got.command, /OFFICE_CHANNEL=my-project /);
  got = install({}, ['--channel=other']);
  assert.match(got.command, /OFFICE_CHANNEL=other /);
  // OFFICE_CHANNEL set by hand still works, outside a panel session and inside one.
  got = install({ OFFICE_CHANNEL: 'mine' });
  assert.match(got.command, /OFFICE_CHANNEL=mine /);
  got = install(Object.assign({}, inherited, { OFFICE_CHANNEL: 'mine' }));
  assert.match(got.command, /OFFICE_CHANNEL=mine /);
  // A session an older relay started has OFFICE_TERMINAL_ID but no OFFICE_PANEL_CHANNEL.
  got = install({ OFFICE_CHANNEL: 'my-project', OFFICE_TERMINAL_ID: 'x' });
  assert.doesNotMatch(got.command, /OFFICE_CHANNEL/);
  // --settings prints the same, and says how to pick a channel.
  const p = spawnSync('node', [path.join(ROOT, 'relay', 'office-hook.js'), '--settings', '--channel', 'b c'], { env: Object.assign({}, process.env, inherited, { OFFICE_RELAY_KEY: 'k' }), encoding: 'utf8' });
  assert.match(JSON.parse(p.stdout).hooks.Stop[0].hooks[0].command, /OFFICE_CHANNEL='b c' /);
  assert.match(p.stderr, /--channel <name>/);
});
