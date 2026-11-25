// Which PRs the nightly Exhibit run checks (.github/workflows/exhibit.yml). A plain function with no side
// effects, so the tests run it without GitHub. See docs/manual/roles.html#exhibit.
//
//   pick({ prs, stored, now, hours, max }) -> [{ pr, head }], the newest first
//
// prs is the list from gh pr list --state all --json number,headRefOid,state,isCrossRepository,updatedAt.
// stored is the paths on the exhibit-data branch under prs/, such as prs/12/<head sha>.json. A PR is checked
// when it is open or merged, comes from a branch of this repo (a fork's code never runs here), was updated in
// the last hours, and has no stored exhibit for its head yet. At most max PRs go in one night, so the cost has a
// ceiling. As a command it reads the PR list on stdin, takes --hours, --max and --stored FILE, and prints the
// list as JSON on one line.
'use strict';
const fs = require('fs');

const SHA = /^[0-9a-f]{40}$/;

function pick({ prs, stored, now, hours, max }) {
  const have = new Set(stored || []);
  const since = now - hours * 3600 * 1000;
  return (prs || [])
    .filter((p) => p && Number.isInteger(p.number) && p.number > 0 && SHA.test(p.headRefOid || ''))
    .filter((p) => p.state === 'OPEN' || p.state === 'MERGED')
    .filter((p) => p.isCrossRepository === false)
    .filter((p) => Date.parse(p.updatedAt) >= since)
    .filter((p) => !have.has('prs/' + p.number + '/' + p.headRefOid + '.json'))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, max)
    .map((p) => ({ pr: p.number, head: p.headRefOid }));
}

function number(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) { console.error('--' + name + ' must be a whole number of 1 or more, not "' + value + '".'); process.exit(2); }
  return n;
}

function main(argv) {
  const arg = (name, fallback) => { const i = argv.indexOf('--' + name); return i < 0 ? fallback : argv[i + 1]; };
  const hours = number(arg('hours', '48'), 'hours');
  const max = number(arg('max', '30'), 'max');
  const file = arg('stored', '');
  const stored = file ? fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : [];
  const prs = JSON.parse(fs.readFileSync(0, 'utf8') || '[]');
  console.log(JSON.stringify(pick({ prs, stored, now: Date.now(), hours, max })));
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { pick };
