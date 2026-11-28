// Speech bubbles: how long one stays up, the order of the manager's lines, and where name tags go
// so a bubble above a tag does not cover the tags behind it. office.js uses them on the room page.
// relay/test/bubbles.test.js runs it in a context with a window of its own.
(function () {
  'use strict';
  const GAP = 26;

  function showSecs(text, secs, long) { return Math.max(secs || 2.5, long ? 2 + text.length / 15 : 0); }

  function deck(lines, last, random) {
    const cards = lines.slice();
    for (let i = cards.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [cards[i], cards[j]] = [cards[j], cards[i]]; }
    if (cards.length > 1 && cards[cards.length - 1] === last) cards.unshift(cards.pop());
    return cards;
  }

  function stackTags(tags) {
    const clear = (t, placed, up) => {
      for (let moved = true; moved;) {
        moved = false;
        for (let i = 0; i < placed; i++) {
          const p = tags[i];
          if (Math.abs(t.x - p.x) >= (t.w + p.w) / 2 + 4) continue;
          const above = p.y - p.h - 2, below = p.y + t.h + 2;
          if (t.y > above && t.y < below) { t.y = up ? above : below; moved = true; }
        }
      }
    };
    tags.sort((a, b) => b.y - a.y);
    tags.forEach((t, i) => clear(t, i, true));
    if (!tags.some((t) => t.y < t.h)) return;
    tags.sort((a, b) => a.y - b.y);
    tags.forEach((t, i) => { t.y = Math.max(t.y, t.h); clear(t, i, false); });
  }

  window.OfficeBubbles = { GAP, showSecs, deck, stackTags };
})();
