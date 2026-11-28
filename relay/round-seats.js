// The seats of a round of a game (relay/games.js): where their folders live, and what their hooks may
// tell the room. One place for both, since relay/games.js, relay/sessions.js, relay/server.js and
// relay/office-hook.js all need them.
'use strict';
const path = require('path');

const dir = () => path.join(require('./state.js').dir(), 'seats');

const WORDS = ['prompt', 'title', 'customTitle', 'message', 'tool_input', 'huddle_id', 'huddle_answer', 'pr_url', 'on_main', 'cwd'];
const IDLE = /waiting for your input|idle/i;

function quiet(event) {
  const out = Object.assign({}, event);
  if (out.hook_event_name === 'Notification' && IDLE.test(String(out.message || '')) && !IDLE.test(String(out.notification_type || ''))) out.notification_type = 'idle_prompt';
  for (const k of WORDS) delete out[k];
  return out;
}

module.exports = { dir, quiet, WORDS };
