// How tired a session is: how much of its context window it has used since its last /clear or
// refresh. Claude Code gives the number to a session's status line (context_window.used_percentage);
// relay/status-line.js prints the level there and sends the number to the relay, which keeps it with
// the session (relay/terminal.js). The Floor shows the Lead's, and ticket.js floor and ticket.js tired
// say it to the Lead. One set of levels for all of them, here. Plain functions, so the tests run them.
//
// Refresh the Lead (relay/lead-refresh.js) starts only when the person presses it, so there is no
// start point to match. Needs a refresh begins at 70%: well before Claude Code compacts the
// conversation by itself, which is when a long-running Lead forgets decisions.
'use strict';

const TIRED_AT = 50;
const REFRESH_AT = 70;
const LEVELS = {
  fresh: { key: 'fresh', icon: '○', label: 'fresh' },
  tired: { key: 'tired', icon: '◑', label: 'getting tired' },
  refresh: { key: 'refresh', icon: '●', label: 'needs a refresh' },
};

function percentOf(input) {
  const cw = input && input.context_window;
  if (!cw || typeof cw !== 'object') return null;
  if (typeof cw.used_percentage === 'number' && isFinite(cw.used_percentage)) return clamp(cw.used_percentage);
  const u = cw.current_usage, size = Number(cw.context_window_size);
  if (!u || typeof u !== 'object' || !(size > 0)) return null;
  const used = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((n, k) => n + (Number(u[k]) || 0), 0);
  return clamp(used / size * 100);
}
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

function levelOf(percent) {
  if (typeof percent !== 'number' || !isFinite(percent)) return null;
  return percent >= REFRESH_AT ? LEVELS.refresh : percent >= TIRED_AT ? LEVELS.tired : LEVELS.fresh;
}

function readingOf(input, now) {
  const percent = percentOf(input);
  if (percent === null) return null;
  const size = Number(input.context_window.context_window_size) || null;
  return { percent, size, sessionId: String(input.session_id || ''), at: now };
}

function tiredOf(t) {
  const c = t && t.context;
  if (!c || !t.sessionId || c.sessionId !== t.sessionId) return null;
  const level = levelOf(c.percent);
  return Object.assign({ percent: c.percent, size: c.size, at: new Date(c.at).toISOString() }, level);
}

const words = (x) => x ? 'context ' + x.percent + '% used, ' + x.label : 'context use not known yet';

module.exports = { TIRED_AT, REFRESH_AT, LEVELS, percentOf, levelOf, readingOf, tiredOf, words };
