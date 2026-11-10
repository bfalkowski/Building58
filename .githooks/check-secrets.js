#!/usr/bin/env node
// Stops a commit that adds a key or password. Reads only what is staged, and only added lines.
// With --diff BASE [HEAD], it reads what HEAD adds since BASE instead. CI runs it that way on each
// pull request, so a secret that got past the hook (not turned on, or --no-verify) still fails.
// With --all, it reads every line of every tracked file (git ls-files) as it is in this checkout, so
// edits not yet committed count. It skips binary files. A secret already on main, or one from before
// the check existed, is found. CI's Secret scan job runs it.
// It never prints the value it found, so the secret does not end up in a terminal or a log.
// A false alarm: put "secret-check: allow" on that line. Skip it once: git commit --no-verify.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RULES = [
  ['a private key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/],
  ['an AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ['an Anthropic or OpenAI key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['a Slack token', /\bxox[abeprs]-[A-Za-z0-9-]{10,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a Stripe key', /\b[sr]k_live_[0-9A-Za-z]{16,}/],
  ['a password in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/@'"$<{]{3,}@[^\s/]/i]
];
// NAME = "value" or NAME=value. The value is judged by looksReal, since most of these in code are not secrets.
const ASSIGNED = /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|private[_-]?key|client[_-]?secret)[\w-]*["']?\s*(?:=|:)\s*(["'`]?)([^\s"'`,;)]+)\1/gi;
const PLACEHOLDER = /^(pick-a-|your[-_]|my[-_]|test|fake|dummy|example|sample|changeme|change-me|placeholder|none|null|undefined|true|false|xxx|\*\*\*|<|\$|\{|%)/i;
const FILES = /(^|\/)(\.env(\.(?!example$|sample$|template$)[^/]+)?|\.envrc(\.(?!example$|sample$|template$)[^/]+)?|id_(rsa|dsa|ecdsa|ed25519)|[^/]+\.(pem|p12|pfx|key|keystore)|\.npmrc|\.netrc|credentials\.json)$/i;

function looksReal(quote, value) {
  if (value.length < 8 || PLACEHOLDER.test(value)) return false;
  // Unquoted, it is usually code: process.env.X, crypto.randomBytes(16), a variable name.
  if (!quote && (/[.()[\]]/.test(value) || /^[a-z_$][\w$]*$/i.test(value))) return false;
  return true;
}
// options.allow false ignores the allow marker, for text that is not the repo's own, such as the
// security officer's report (relay/security.js).
function checkLine(line, options) {
  if ((!options || options.allow !== false) && line.includes('secret-check: allow')) return null;
  for (const [what, re] of RULES) if (re.test(line)) return what;
  for (const m of line.matchAll(ASSIGNED)) if (looksReal(m[1], m[2])) return 'a password or key being assigned';
  return null;
}
function git(...args) { return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }

// which is ['--cached'] for the staged lines, or [BASE, HEAD] for what HEAD adds since BASE.
function added(which) {
  const found = [];
  for (const file of git('diff', ...which, '--name-only', '-z', '--diff-filter=ACMR').split('\0').filter(Boolean)) {
    if (FILES.test(file)) { found.push(file + ': a file that holds secrets'); continue; }
    let at = 0;
    for (const line of git('diff', ...which, '--no-color', '--no-ext-diff', '-U0', '--', file).split('\n')) {
      const hunk = /^@@ -\S+ \+(\d+)/.exec(line);
      if (hunk) { at = Number(hunk[1]); continue; }
      if (!at || !line.startsWith('+')) continue;
      const what = checkLine(line.slice(1));
      if (what) found.push(file + ':' + at + ': ' + what);
      at++;
    }
  }
  return found;
}

// Every tracked file, every line. Binary files (a NUL byte in the first 8000, as git judges) are skipped,
// and so are symlinks and submodules, which are not text this repo holds. dir is a folder in the repo,
// or the current one.
function tracked(dir) {
  const top = git(...(dir ? ['-C', dir] : []), 'rev-parse', '--show-toplevel').trim();
  const found = [];
  for (const file of git('-C', top, 'ls-files', '-z').split('\0').filter(Boolean)) {
    if (FILES.test(file)) { found.push(file + ': a file that holds secrets'); continue; }
    const full = path.join(top, file);
    let st;
    // Deleted here, not yet committed: gone (ENOENT), or a file now stands where its folder was (ENOTDIR).
    try { st = fs.lstatSync(full); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue; throw e; }
    if (!st.isFile()) continue;
    const buf = fs.readFileSync(full);
    if (buf.subarray(0, 8000).includes(0)) continue;
    buf.toString('utf8').split('\n').forEach((line, i) => {
      const what = checkLine(line);
      if (what) found.push(file + ':' + (i + 1) + ': ' + what);
    });
  }
  return found;
}

// The command line. The security officer (relay/access.js) requires this file for checkLine and tracked.
function main() {
  if (process.argv.includes('--all')) {
    let found;
    try {
      found = tracked();
    } catch (e) {
      console.error('Secret scan: could not read the tracked files. ' + String(e.stderr || e.message).trim());
      process.exit(1);
    }
    if (found.length) {
      console.error('These tracked files look like they hold a secret:\n');
      for (const f of found) console.error('  ' + f);
      console.error('\nTake it out and read it from the environment instead. It is in the history, so replace the key as well.');
      console.error('A false alarm? Add "secret-check: allow" to that line. (' + path.basename(__filename) + ' --all)');
      process.exit(1);
    }
    console.log('Secret scan: no secrets in the tracked files.');
    process.exit(0);
  }

  const at = process.argv.indexOf('--diff');
  const range = at < 0 ? null : [process.argv[at + 1], process.argv[at + 2] || 'HEAD'];
  if (range && (!range[0] || range[0].startsWith('-'))) {
    console.error('Secret check: --diff needs the commit to compare with, as in --diff origin/main.');
    process.exit(1);
  }
  let found;
  try {
    found = added(range || ['--cached']);
  } catch (e) {
    // Fail closed: a check that could not read the diff has not passed.
    console.error('Secret check: could not read the diff' + (range ? ' from ' + range.join(' to ') : '') + '. ' + String(e.stderr || e.message).trim());
    process.exit(1);
  }
  if (found.length && range) {
    console.error('These commits look like they add a secret:\n');
    for (const f of found) console.error('  ' + f);
    console.error('\nTake it out in a new commit and read it from the environment instead. It stays in the branch\'s history,');
    console.error('so replace the key as well. A false alarm? Add "secret-check: allow" to that line. (' + path.basename(__filename) + ')');
    process.exitCode = 1;
  } else if (found.length) {
    console.error('Commit stopped. This looks like it adds a secret:\n');
    for (const f of found) console.error('  ' + f);
    console.error('\nTake it out and read it from the environment instead. If it has ever been pushed, replace the key.');
    console.error('A false alarm? Add "secret-check: allow" to that line, or use git commit --no-verify. (' + path.basename(__filename) + ')');
    process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { checkLine, tracked };
