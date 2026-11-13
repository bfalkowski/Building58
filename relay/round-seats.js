// The seats of a round of a game (relay/games.js): where their folders live, and what their hooks may
// tell the room. One place for both, since relay/games.js, relay/sessions.js, relay/server.js and
// relay/office-hook.js all need them.
'use strict';
const path = require('path');

// Every seat folder sits under one parent in the state folder, <state>/seats/<round>/<seat>, so the
// person can trust that one folder in Claude Code once, if Claude Code honors a parent's trust.
const dir = () => path.join(require('./state.js').dir(), 'seats');

// The fields of a hook event that can hold a seat's words: its prompt (the first is its private brief),
// its titles, its notices, what it typed into a tool, and a huddle answer or PR it made.
const WORDS = ['prompt', 'title', 'customTitle', 'message', 'tool_input', 'huddle_id', 'huddle_answer', 'pr_url', 'cwd'];
const IDLE = /waiting for your input|idle/i;

// A copy of a seat's hook event with none of its words. The relay reads a notice's words to tell a seat
// that waits for its next prompt from one that asks a question (relay/terminal.js), so an idle notice
// keeps that fact as its type.
function quiet(event) {
  const out = Object.assign({}, event);
  if (out.hook_event_name === 'Notification' && IDLE.test(String(out.message || '')) && !IDLE.test(String(out.notification_type || ''))) out.notification_type = 'idle_prompt';
  for (const k of WORDS) delete out[k];
  return out;
}

module.exports = { dir, quiet, WORDS };
