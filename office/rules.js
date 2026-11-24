// Standing rules in Settings: what you say holds for a while, such as "do not touch the payments folder
// until Friday". Each has its text, its reason and when it ends. The relay (relay/rules.js) puts the ones
// in force at the end of each new brief. A rule past its date shows as ended and leaves briefs by itself.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const dialog = $('settings'), list = $('rules-list'), form = $('rules-form'), said = $('rules-said');
  const params = new URLSearchParams(location.search);
  const channel = params.get('channel'), key = params.get('key') || '';
  if (!dialog || !list || !channel) return;

  const url = (p) => location.origin + '/channels/' + encodeURIComponent(channel) + '/rules' + p + '?key=' + encodeURIComponent(key);
  function api(p, body) {
    const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    return fetch(url(p), opt).then((r) => r.text().then((t) => { try { return JSON.parse(t); } catch (e) { return { ok: false, message: 'The relay answered with a page, not JSON (' + r.status + '). On the public page your sign-in may have run out: reload it.' }; } }), () => ({ ok: false, message: 'The relay did not answer.' }));
  }
  const tell = (text, bad) => { said.textContent = text; said.dataset.state = bad ? 'off' : ''; };

  const stop = (v) => v.replace(/[.\s]+$/, '') + '.';
  function draw(rules) {
    list.textContent = '';
    if (!rules.length) { const p = document.createElement('p'); p.className = 'set-what'; p.textContent = 'No standing rules.'; list.append(p); return; }
    for (const r of rules) {
      const row = document.createElement('div'), head = document.createElement('div'), what = document.createElement('p'), drop = document.createElement('button');
      row.className = 'set-row'; row.dataset.rule = r.id;
      head.textContent = r.text + ' ';
      what.className = 'set-what';
      what.textContent = 'Why: ' + stop(r.reason) + ' ' + (r.ended ? 'Ended ' + r.until + ': it is no longer in briefs.' : r.until ? 'In force through ' + r.until + '.' : 'In force until you remove it.');
      drop.type = 'button'; drop.className = 'btn'; drop.textContent = 'Remove';
      drop.setAttribute('aria-label', 'Remove the rule: ' + r.text);
      drop.addEventListener('click', async () => {
        const out = await api('/' + encodeURIComponent(r.id) + '/remove', {});
        if (out.ok) { draw(out.rules); tell('Removed.'); } else tell(out.message || 'The relay refused.', true);
      });
      head.append(drop);
      row.append(head, what);
      list.append(row);
    }
  }
  async function load() { const out = await api(''); if (out.ok) draw(out.rules); else tell(out.message || 'The relay did not answer.', true); }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = $('rules-text').value, reason = $('rules-reason').value, until = $('rules-until').value;
    const out = await api('', { text, reason, until: until || null });
    if (!out.ok) { tell(out.message || 'The relay refused.', true); return; }
    form.reset();
    draw(out.rules);
    tell('Added. New briefs carry it. Sessions already running do not get it.');
  });

  new MutationObserver(() => { if (dialog.open) load(); }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  if (dialog.open) load();
})();
