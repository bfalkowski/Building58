#!/usr/bin/env node
// Stands in for gh when the relay keeps tickets on GitHub and also runs gh for a PR: `gh api` goes to
// fake-github.js (state in FAKE_GITHUB_DIR) and every other call goes to fake-gh.js (state in FAKE_GH_DIR).
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const which = process.argv[2] === 'api' ? 'fake-github.js' : 'fake-gh.js';
const r = spawnSync('node', [path.join(__dirname, which), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
