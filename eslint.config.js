'use strict';
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', '.worktrees/', 'test-results/'] },
  js.configs.recommended,
  {
    rules: {
      // `catch (e)` with no use of e, and `const { id: _id, ...rest }` to drop a key, are how this
      // code is written on purpose. Neither hides a bug, and changing them would touch about 50 lines.
      'no-unused-vars': ['error', { caughtErrors: 'none', ignoreRestSiblings: true }]
    }
  },
  {
    files: ['relay/**/*.js', '.githooks/**/*.js', 'office/baked/**/*.js', 'office/record-trailer.js', 'office/trailer-music.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node }
  },
  {
    // The browser tests run in Node, and the functions they pass to the page run there.
    files: ['relay/test/browser/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  },
  {
    // The pages share one global scope. Their own scripts talk through window, so only what the
    // CDN script tags load needs naming here. Terminal and FitAddon are read from window too.
    files: ['office/**/*.js', 'shared/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, THREE: 'readonly' } }
  },
  {
    // Also loaded with require: by relay/office.js, relay/server.js (the roster), and by the tests.
    files: ['office/demo-session.js', 'office/look.js', 'office/seats.js', 'office/roster.js', 'office/poses.js', 'office/holidays.js', 'office/reviews.js', 'office/board-model.js', 'office/manager-lines.js'],
    languageOptions: { globals: { module: 'writable' } }
  },
  {
    // Relay code cannot switch a rule off for one line, so a copy of clean() fails lint with no way around it.
    files: ['relay/**/*.js'],
    ignores: ['relay/test/**'],
    linterOptions: { noInlineConfig: true, reportUnusedInlineConfigs: 'off' },
    rules: {
      'no-restricted-syntax': ['error', {
        selector: 'Literal[regex.pattern=/\\\\x[01][0-9a-fA-F]|\\\\x[79][fF]/]',
        message: 'Use oneLine or keepLines from relay/clean.js. Do not copy the control character regex.'
      }]
    }
  },
  {
    // Removing control characters is what clean.js does, and terminal.js reads terminal escape codes.
    files: ['relay/clean.js', 'relay/terminal.js'],
    rules: { 'no-control-regex': 'off', 'no-restricted-syntax': 'off' }
  }
];
