// The relay's API version, worked out from docs/api-changes/, one file for each change to the API.
// A file starts with MAJOR, MINOR or PATCH, a colon and what changed. The version is BASE plus one
// for each file, in the part its first word names, so two pull requests that each add a file never
// edit the same line, and the version is the same whatever order they merge in (docs/constitution.md,
// article 15). The relay puts it in the document it serves at /docs/openapi.json. To fold the files
// into a new BASE, add them up here and delete them in one pull request.
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = [2, 16, 0];
const DIR = path.join(__dirname, '..', 'docs', 'api-changes');
const PARTS = ['MAJOR', 'MINOR', 'PATCH'];
const LINE = /^(MAJOR|MINOR|PATCH): \S.*$/;
const isChange = (name) => name.endsWith('.md') && name !== 'README.md';

function problems(name, text) {
  const first = String(text).split('\n')[0];
  return LINE.test(first) ? [] : [name + ' must start with MAJOR, MINOR or PATCH, a colon, a space and what changed.'];
}

function versionOf(texts) {
  const v = BASE.slice();
  for (const text of texts) {
    const at = PARTS.indexOf(String(text).split(':')[0]);
    if (at >= 0) v[at]++;
  }
  return v.join('.');
}

const names = (dir = DIR) => fs.readdirSync(dir).filter(isChange).sort();
const current = (dir = DIR) => versionOf(names(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')));

module.exports = { BASE, DIR, LINE, isChange, problems, versionOf, names, current };
