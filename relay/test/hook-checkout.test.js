// GET /terminals says when the hooks in ~/.claude/settings.json run office-hook.js from another
// checkout than the relay's own (T-57). Those sessions run old hook code, so new hook fields never arrive.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');
const { relay, ROOT } = require('./helpers.js');

const install = (home, script) => execFileSync('node', [script, '--install'], { env: { ...process.env, HOME: home, OFFICE_RELAY_KEY: 'secret-hook-key' }, stdio: 'ignore' });

test('the relay says whether the global hooks run its own office-hook.js', async (t) => {
  const R = await relay();
  t.after(() => R.stop());
  const own = fs.realpathSync(path.join(ROOT, 'relay', 'office-hook.js'));
  const check = async () => { const r = await R.call('GET', '/terminals'); assert.strictEqual(r.status, 200); return r; };

  // No global hooks: no warning.
  let r = await check();
  assert.deepStrictEqual([r.body.hookCheckout.installed, r.body.hookCheckout.match, r.body.hookCheckout.fix], [false, true, null]);

  // Installed from this checkout: they match.
  install(R.home, path.join(ROOT, 'relay', 'office-hook.js'));
  r = await check();
  assert.deepStrictEqual([r.body.hookCheckout.installed, r.body.hookCheckout.match, r.body.hookCheckout.fix], [true, true, null]);
  assert.strictEqual(r.body.hookCheckout.own, own);

  // Installed from another checkout, as an old worktree with a space in its name.
  const old = path.join(R.home, 'old worktree', 'relay');
  fs.mkdirSync(old, { recursive: true });
  fs.copyFileSync(own, path.join(old, 'office-hook.js'));
  install(R.home, path.join(old, 'office-hook.js'));
  r = await check();
  const c = r.body.hookCheckout;
  assert.deepStrictEqual([c.installed, c.match], [true, false]);
  assert.deepStrictEqual(c.from, [path.join(old, 'office-hook.js')]);
  assert.strictEqual(c.fix, 'cd ' + path.dirname(path.dirname(own)) + ' && RELAY_KEY=<your relay key> npm run office:hooks');
  assert.ok(!JSON.stringify(r.body).includes('secret-hook-key'), 'the key in the hook command never leaves the relay');

  // A hook written by hand with a relative path runs a file that depends on each session's folder,
  // so the relay does not count it either way.
  const file = path.join(R.home, '.claude', 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'OFFICE_RELAY_KEY=k node ../old/relay/office-hook.js' }] }] } }));
  r = await check();
  assert.deepStrictEqual([r.body.hookCheckout.match, r.body.hookCheckout.from, r.body.hookCheckout.fix], [true, [], null]);
});
