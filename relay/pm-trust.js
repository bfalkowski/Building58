// PM trust: the one setting that says how much the PM may do (docs/constitution.md, article 5). Each rung
// does everything the rungs below it do. A room that had Let the PM set the order on reads as ORDER
// (relay/config.js). See docs/manual/roles.html#pm-trust.
'use strict';
const config = require('./config.js');

const OFF = 0, ADVISE = 1, HOLD = 2, ORDER = 3, MERGE = 4;
const NAMES = ['Off', 'Advise', 'Hold and propose', 'Order', 'Close and merge'];
const level = () => config.get('pmTrust');
const may = (rung) => level() >= rung;
const nameOf = (rung) => NAMES[rung] || String(rung);

module.exports = { OFF, ADVISE, HOLD, ORDER, MERGE, NAMES, level, may, nameOf };
