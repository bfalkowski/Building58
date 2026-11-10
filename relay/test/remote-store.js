// A store that stands for one off this computer, such as GitHub issues: the memory store without local.
'use strict';
const memory = require('./memory-store.js');
function open() { const s = memory.open(); return { ...s, name: 'remote', local: false }; }
module.exports = { open };
