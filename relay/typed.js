// How the relay writes text into a session's prompt (relay/terminal.js). Claude Code reads keys about
// 1024 bytes at a time, and was seen keeping only the last piece of a long message (T-34). Marked as one
// paste, all of it arrives (2942 characters, with real Claude Code). So text from PASTE_FROM bytes up
// goes in as a paste, and shorter text as keys, which always fit in one read. Bytes, not characters:
// the read counts bytes, and a path or a name can hold letters of two bytes or more. The Lead's brief
// names full paths, so it grows with the checkout root, and this is what lets it arrive whole however
// long the root is (T-85).
'use strict';
const PASTE_FROM = 800;
const asTyped = (text) => (Buffer.byteLength(text) < PASTE_FROM ? text : '\x1b[200~' + text.split('\x1b').join('') + '\x1b[201~');
module.exports = { asTyped, PASTE_FROM };
