// Text from a session, a person or GitHub goes through one of these before the relay keeps or shows it.
// oneLine turns control characters and runs of space into one space, for a title, a name or a chat line.
// keepLines takes control characters out but keeps line breaks and tabs, for a ticket body or a brief.
'use strict';
const text = (v) => String(v == null ? '' : v);
const CONTROL = /[\x00-\x1f\x7f-\x9f]+/g;
const CONTROL_BUT_LINES = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

const oneLine = (v, n) => text(v).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const keepLines = (v, n) => text(v).replace(CONTROL_BUT_LINES, '').slice(0, n);

module.exports = { oneLine, keepLines };
