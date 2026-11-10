// The short summary a ticket's chat channel leaves on its ticket when it is deleted (relay/chat.js).
// It has no side effects, so a test can load it without starting the relay's stores.
'use strict';
function summaryOf(room, why) {
  const n = room.said || 0, who = room.senders || [];
  const at = (iso) => iso.slice(0, 16).replace('T', ' ');
  const when = n ? ', from ' + at(room.firstAt) + ' to ' + (room.firstAt.slice(0, 10) === room.lastAt.slice(0, 10) ? room.lastAt.slice(11, 16) : at(room.lastAt)) + ' UTC' : '';
  return 'Chat #' + room.name + ' was deleted ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC because ' + why + '. It had ' + n + ' post' + (n === 1 ? '' : 's') +
    (who.length ? ' from ' + who.join(', ') : '') + when + '. The posts themselves are not kept.';
}
module.exports = { summaryOf };
