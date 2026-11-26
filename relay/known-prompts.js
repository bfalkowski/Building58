// Claude Code's own prompts, which the room closes, and what the room reads of any other menu. On 2026-11-25
// four Devs sat for up to an hour behind "Teach auto mode about your environment?", a prompt Claude Code shows
// in every session once 5 auto mode denials are counted in the shared config. The room holds every message
// behind a menu, so it must tell Claude Code's own prompts from a question a Dev asks.
//
// A known prompt has a text to match on the screen with its spaces taken out (screenOf in relay/terminal.js),
// and a list of keys to try, safest first. Each key chooses what dismisses the prompt for good, or for now,
// and none of them chooses Yes. A prompt not in the list is never answered: menuText gives its text and its
// choices for Needs you and the Lead's look. Plain functions, so the tests run them without a relay.
// See docs/manual/how-it-works.html#known-prompts.
//
//   identify(screen) -> { id, label, answer, keys } or null, for the last known prompt in a screen
//   menuText(plain) -> { text, choices }, the words of the menu at the end of a terminal's text, its escapes taken out
'use strict';
const { oneLine } = require('./clean.js');

const KNOWN = [
  { id: 'auto-mode-environment', label: 'Teach auto mode about your environment?', answer: 'Don\'t show again', match: /Teachautomodeaboutyourenvironment/i, keys: ['3', '\x1b'] },
  { id: 'feedback-survey', label: 'How is Claude doing this session?', answer: 'Dismiss', match: /HowisClaudedoingthissession/i, keys: ['0', '\x1b'] },
];

function identify(screen) {
  let found = null, at = -1;
  for (const k of KNOWN) {
    const m = new RegExp(k.match.source, 'ig');
    let last;
    for (let r = m.exec(screen); r; r = m.exec(screen)) last = r;
    if (last && last.index > at) { found = k; at = last.index; }
  }
  return found ? { id: found.id, label: found.label, answer: found.answer, keys: found.keys } : null;
}

const CHOICE = /^[❯>›]?\s*\d+\.\s+\S/;
const MAX_CHOICES = 8;

function menuText(plain) {
  const lines = plain.split(/\r\n|\r|\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  let end = lines.length - 1;
  while (end >= 0 && !CHOICE.test(lines[end])) end--;
  if (end < 0) return { text: oneLine(lines.slice(-4).join(' '), 300), choices: [] };
  let start = end;
  while (start > 0 && CHOICE.test(lines[start - 1])) start--;
  const choices = lines.slice(start, end + 1).slice(0, MAX_CHOICES).map((l) => oneLine(l.replace(/^[❯>›]\s*/, ''), 80));
  const before = lines.slice(Math.max(0, start - 3), start);
  const asked = before.findIndex((l) => l.endsWith('?'));
  return { text: oneLine((asked >= 0 ? before.slice(asked) : before.slice(-1)).join(' '), 300), choices };
}

module.exports = { KNOWN, identify, menuText };
