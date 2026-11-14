// A made-up Claude Code transcript for a seat, written where Claude Code keeps it
// (<home>/.claude/projects/<the folder, each sign a dash>/<session id>.jsonl). The fake claude writes
// none, so the tests write this one for it. It has the shape of a real one: Claude Code's own notes in
// <system-reminder> blocks, one assistant message on several lines that each repeat its usage, and lines
// that are not the conversation.
'use strict';
const fs = require('fs');
const path = require('path');
const seatBoundary = require('../seat-boundary.js');

// Each usage line is for one request: 1000 input, 2000 written to the 1 hour cache, 10000 read from it,
// 500 out. At Claude Opus 5.5 prices that is (1000*4 + 2000*8 + 10000*0.2 + 500*20) / 1e6 = 0.032 dollars.
const USAGE = { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10000, output_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 } };
const REQUEST_USD = 0.032;

function lines({ brief, model, requests }) {
  const out = [{ type: 'mode', mode: 'default' }];
  out.push({ type: 'user', message: { role: 'user', content: '<pasted_content id="ab12">\n' + brief + '\n</pasted_content id="ab12">' } });
  out.push({ type: 'user', isMeta: true, message: { role: 'user', content: 'META-MARK a note Claude Code keeps for itself' } });
  out.push({ type: 'user', message: { role: 'user', content: '<system-reminder>\nREMINDER-MARK the person\'s own rules, and person@example.com\n</system-reminder>' } });
  out.push({ type: 'attachment', attachment: { type: 'environment' }, rendered: '<system-reminder>REMINDER-MARK</system-reminder>' });
  for (let i = 0; i < (requests || 1); i++) {
    const id = 'msg_' + i;
    out.push({ type: 'assistant', message: { id, role: 'assistant', model, usage: USAGE, content: [{ type: 'thinking', thinking: 'THINK-MARK' }] } });
    out.push({ type: 'assistant', message: { id, role: 'assistant', model, usage: USAGE, content: [{ type: 'text', text: 'SAYS-MARK step ' + i }] } });
    out.push({ type: 'assistant', message: { id, role: 'assistant', model, usage: USAGE, content: [{ type: 'tool_use', id: 'tu' + i, name: 'Bash', input: { command: 'node "$OFFICE_PLAY" ask --json \'{}\'' } }] } });
    out.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu' + i, content: 'RESULT-MARK ' + i + '\n<system-reminder>REMINDER-MARK in a result</system-reminder>' }] } });
  }
  out.push({ type: 'assistant', message: { id: 'msg_end', role: 'assistant', model: '<synthetic>', usage: USAGE, content: [{ type: 'text', text: 'I am done.' }] } });
  return out.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

// Writes the transcript of a session in cwd. Returns its path.
function writeTranscript(home, cwd, sessionId, opts) {
  const dir = path.join(home, '.claude', 'projects', seatBoundary.projectFolder(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sessionId + '.jsonl');
  fs.writeFileSync(file, lines(Object.assign({ brief: 'BRIEF', model: 'claude-opus-5-5', requests: 1 }, opts)));
  return file;
}

module.exports = { writeTranscript, REQUEST_USD };
