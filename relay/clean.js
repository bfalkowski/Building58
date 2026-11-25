// Text from a session, a person or GitHub goes through one of these before the relay keeps or shows it.
// oneLine turns control characters and runs of space into one space, for a title, a name or a chat line.
// noHidden takes out zero-width characters and bidi controls, so text cannot hide or reorder what prints after it.
// keepLines takes control characters out but keeps line breaks and tabs, for a ticket body or a brief.
'use strict';
const text = (v) => String(v == null ? '' : v);
const CONTROL = /[\x00-\x1f\x7f-\x9f]+/g;
const CONTROL_BUT_LINES = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

const HIDDEN = /\u034f|[\u00ad\u180e\u200b-\u200f\u2060-\u2064\u202a-\u202e\u2066-\u2069\u061c\ufeff]/g;
const noHidden = (v) => text(v).replace(HIDDEN, '');

const oneLine = (v, n) => text(v).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const keepLines = (v, n) => text(v).replace(CONTROL_BUT_LINES, '').slice(0, n);

module.exports = { oneLine, keepLines, noHidden, HIDDEN };
