// Remote mode: the relay checks a Cloudflare Access sign-in itself, so a wrong Access setting cannot
// open the room. Off unless RELAY_REMOTE=1. With RELAY_REMOTE_FULL=1, a request that passed counts as
// local for the local-only rule (ownerHere). Node's built-in crypto only. See docs/manual/relay.html#remote.
'use strict';
const crypto = require('crypto');

const KEYS_FRESH_MS = 60 * 60 * 1000;
const KEYS_RETRY_MS = 60 * 1000;
const CF_HEADERS = ['cf-access-jwt-assertion', 'cf-ray', 'cf-connecting-ip', 'cf-visitor'];
const owners = new WeakSet();
const ownerHere = (req) => owners.has(req);

function fromEnv(env) {
  if (env.RELAY_REMOTE !== '1') return null;
  const need = ['RELAY_REMOTE_URL', 'RELAY_ACCESS_TEAM', 'RELAY_ACCESS_AUD', 'RELAY_ACCESS_EMAIL'];
  const missing = need.filter((k) => !String(env[k] || '').trim());
  if (missing.length) throw new Error('RELAY_REMOTE=1 needs ' + missing.join(', ') + '.');
  let url;
  try { url = new URL(env.RELAY_REMOTE_URL.trim()); } catch (e) { throw new Error('RELAY_REMOTE_URL is not an address: ' + env.RELAY_REMOTE_URL); }
  if (url.protocol !== 'https:') throw new Error('RELAY_REMOTE_URL must start with https://.');
  const team = env.RELAY_ACCESS_TEAM.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '');
  if (!/^[a-z0-9.-]+$/.test(team)) throw new Error('RELAY_ACCESS_TEAM is a domain such as myteam.cloudflareaccess.com.');
  const mfa = String(env.RELAY_ACCESS_MFA || 'amr').trim().toLowerCase();
  if (mfa !== 'amr' && mfa !== 'cloudflare') throw new Error('RELAY_ACCESS_MFA is amr or cloudflare, not ' + env.RELAY_ACCESS_MFA + '.');
  const full = String(env.RELAY_REMOTE_FULL || '0').trim();
  if (full !== '0' && full !== '1') throw new Error('RELAY_REMOTE_FULL is 1 or 0, not ' + env.RELAY_REMOTE_FULL + '.');
  return {
    host: url.host.toLowerCase(), origin: url.origin, issuer: 'https://' + team,
    aud: env.RELAY_ACCESS_AUD.trim(), email: env.RELAY_ACCESS_EMAIL.trim().toLowerCase(), mfa, full: full === '1',
    certsUrl: env.RELAY_ACCESS_CERTS_URL || 'https://' + team + '/cdn-cgi/access/certs'
  };
}

const b64 = (s) => Buffer.from(s, 'base64url');
const json = (s) => { const v = JSON.parse(b64(s).toString('utf8')); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object'); return v; };

function gate(cfg, opts) {
  const now = (opts && opts.now) || Date.now;
  const get = (opts && opts.fetch) || ((u) => fetch(u, { signal: AbortSignal.timeout(5000) }));
  let keys = new Map(), loaded = 0, tried = -KEYS_RETRY_MS;

  async function load() {
    tried = now();
    const r = await get(cfg.certsUrl);
    if (!r.ok) throw new Error('keys: ' + r.status);
    const body = await r.json();
    const next = new Map();
    for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
      if (jwk && jwk.kty === 'RSA' && typeof jwk.kid === 'string') next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    }
    keys = next; loaded = now();
  }
  async function keyFor(kid) {
    if ((!loaded || now() - loaded > KEYS_FRESH_MS) && now() - tried > KEYS_RETRY_MS) await load().catch(() => {});
    if (!keys.has(kid) && now() - tried > KEYS_RETRY_MS) await load().catch(() => {});
    return keys.get(kid) || null;
  }

  const applies = (req) => String(req.headers.host || '').toLowerCase() === cfg.host || CF_HEADERS.some((h) => req.headers[h] !== undefined);

  async function allows(req) {
    try {
      const token = req.headers['cf-access-jwt-assertion'];
      if (typeof token !== 'string') return false;
      const parts = token.split('.');
      if (parts.length !== 3) return false;
      const head = json(parts[0]);
      if (head.alg !== 'RS256' || typeof head.kid !== 'string') return false;
      const key = await keyFor(head.kid);
      if (!key || !crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, b64(parts[2]))) return false;
      const p = json(parts[1]);
      const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
      if (!aud.includes(cfg.aud) || p.iss !== cfg.issuer) return false;
      const t = Math.floor(now() / 1000);
      if (typeof p.exp !== 'number' || p.exp <= t) return false;
      if (p.nbf !== undefined && (typeof p.nbf !== 'number' || p.nbf > t)) return false;
      if (typeof p.email !== 'string' || p.email.toLowerCase() !== cfg.email) return false;
      if (cfg.mfa === 'amr' && (!Array.isArray(p.amr) || !p.amr.includes('mfa'))) return false;
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== cfg.origin) return false;
      if (cfg.full) owners.add(req);
      return true;
    } catch (e) { return false; }
  }
  return { applies, allows };
}

module.exports = { fromEnv, gate, CF_HEADERS, ownerHere };
