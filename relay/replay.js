// What a page gets when it opens a session or its stream reconnects: the output from the last full-screen
// clear, cut to the newest REPLAY bytes. Older output is old redraws the page would only draw over.
'use strict';

const REPLAY = 32 * 1024;
const LINE_REACH = 4096;
const CLEARS = ['\u001b[2J', '\u001b[3J', '\u001bc'];
const HOMES = ['\u001b[H', '\u001b[1;1H'];

function replayOf(buf) {
  const text = buf.toString('latin1');
  let from = Math.max(0, ...CLEARS.map((c) => text.lastIndexOf(c)));
  for (let c; (c = CLEARS.find((k) => from >= k.length && text.slice(from - k.length, from) === k));) from -= c.length;
  const home = HOMES.find((h) => from >= h.length && text.slice(from - h.length, from) === h);
  if (home) from -= home.length;
  let out = buf.subarray(from);
  if (out.length <= REPLAY) return out;
  out = out.subarray(out.length - REPLAY);
  const nl = out.indexOf(10);
  if (nl >= 0 && nl < LINE_REACH) return out.subarray(nl + 1);
  let i = 0;
  while (i < out.length && (out[i] & 0xc0) === 0x80) i++;
  return out.subarray(i);
}

module.exports = { replayOf, REPLAY, LINE_REACH };
