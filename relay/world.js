#!/usr/bin/env node
// Starts a relay for one world, on that world's own port, with its own key:
//
//   RELAY_KEY=a-key-for-this-world npm run world -- <folder>
//
// <folder> is a world's folder, with a world.json (relay/server.js). The relay serves that world
// alone, so another world's restart, crash or key does not touch it. PORT overrides the world's port.
'use strict';
const dir = process.argv[2];
if (!dir || dir.startsWith('-')) { console.error('Name a world\'s folder, for example: RELAY_KEY=pick-a-key npm run world -- <folder>'); process.exit(1); }
const fs = require('fs');
const path = require('path');
process.env.RELAY_WORLD = dir;
// The supervisor's rollback check (relay/rollback.js) reads PORT, so it is set here to the world's,
// the port the relay picks too.
if (!process.env.PORT) { try { const w = JSON.parse(fs.readFileSync(path.join(process.env.RELAY_ROOT || path.join(__dirname, '..'), dir.replace(/\/+$/, ''), 'world.json'), 'utf8')); if (Number(w.port)) process.env.PORT = String(w.port); } catch { /* the relay says what is wrong */ } }
process.argv.splice(2, 1);
require('./server.js');
