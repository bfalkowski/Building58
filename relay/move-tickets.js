// Moves a room's open tickets from the local store (tickets.json in its state folder) to GitHub issues,
// through the GitHub ticket store (relay/ticket-stores/github.js), so each issue is the same as one the
// room files itself. It runs gh, and no model. The closed tickets stay behind, saved to a file for history.
// See docs/manual/running.html#move-tickets.
//
//   node relay/move-tickets.js --to owner/repo [--state <folder>] [--channel office] [--folder <repo folder>] [--dry-run]
//
// --state is the room's state folder (default ~/.office-world). The issues are signed with the key in that
// folder (github-store.key), so the room that reads them must use the same folder or a copy of that key. RELAY_TICKET_KEY in the environment wins over the key file, and is the same on
// every machine that runs the room.
// --folder is the repo folder the moved tickets are worked in, for each one, in place of what it had.
//
// What it does, in order, and it stops before writing anything if the first step finds a problem:
//   1. Every line of each open ticket (triage, ready, started) goes through the secret check
//      (.githooks/check-secrets.js), since the issues may be public. A hit names the ticket and stops.
//   2. The closed tickets (done, rejected) go to tickets-closed.json in the state folder.
//   3. Each open ticket becomes an issue, oldest first, with "Moved from T-12." at the end of its body. A
//      started ticket comes over as ready, since its task stays with the old store. After each one,
//      tickets-moved.json in the state folder says which issue it became, so a run that stops can be run
//      again and goes on where it stopped, with no ticket filed twice.
//   4. Blockers are set by their new issue numbers. A blocker that is closed is left out, since it no
//      longer blocks, and so is one that did not move.
//
//   node relay/move-tickets.js --to owner/repo --refolder <old folder> --folder <new folder> [--state <folder>] [--dry-run]
//
// Changes the repo folder of each open ticket in those issues from the old folder to the new one, as when
// a room moves into a container and the repo moves from /Users/me/code/repo/app to /home/node/repos/app.
// A ticket worked in another folder is left as it is.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkLine } = require('../.githooks/check-secrets.js');

const OPEN = ['triage', 'ready', 'started'];
const CARRY = ['title', 'priority', 'repo', 'base', 'createdBy', 'labels', 'kind', 'approvedBy', 'rank'];
const order = (t) => Number(String(t.id).replace(/\D/g, '')) || 0;

function secretsIn(tickets) {
  const hits = [];
  for (const t of tickets) {
    const lines = [t.title, ...(String(t.body || '').split('\n')), ...(t.labels || [])];
    for (const line of lines) {
      const what = checkLine(String(line || ''), { allow: false });
      if (what) { hits.push({ id: t.id, what }); break; }
    }
  }
  return hits;
}

function fieldsOf(t, folder) {
  const f = {};
  for (const k of CARRY) if (t[k] !== undefined && t[k] !== null) f[k] = t[k];
  if (folder) f.repo = folder;
  f.status = t.status === 'started' ? 'ready' : t.status;
  f.body = String(t.body || '').replace(/\s+$/, '') + '\n\nMoved from ' + t.id + '.';
  return f;
}

async function move(o) {
  const all = o.tickets.slice().sort((a, b) => order(a) - order(b));
  const open = all.filter((t) => OPEN.includes(t.status)), closed = all.filter((t) => !OPEN.includes(t.status));
  const say = o.say || (() => {});
  const hits = secretsIn(open);
  if (hits.length) return { stopped: 'secrets', hits };
  if (o.dryRun) return { dryRun: true, open: open.length, closed: closed.length, started: open.filter((t) => t.status === 'started').map((t) => t.id), blocked: open.filter((t) => (t.blockedBy || []).length).length };
  fs.writeFileSync(o.closedFile, JSON.stringify({ channel: o.channel, savedAt: new Date().toISOString(), tickets: closed }, null, 2) + '\n');
  const moved = fs.existsSync(o.movedFile) ? JSON.parse(fs.readFileSync(o.movedFile, 'utf8')) : { to: o.to, map: {} };
  if (moved.to !== o.to) throw new Error(o.movedFile + ' is for ' + moved.to + ', not ' + o.to + '.');
  for (const t of open) {
    if (moved.map[t.id]) continue;
    const made = await o.store.create(o.channel, fieldsOf(t, o.folder));
    moved.map[t.id] = String(made.id);
    fs.writeFileSync(o.movedFile, JSON.stringify(moved, null, 2) + '\n');
    say(t.id + ' -> #' + made.id + ' ' + t.title);
    if (o.pauseMs) await new Promise((r) => setTimeout(r, o.pauseMs));
  }
  let linked = 0;
  for (const t of open) {
    const want = (t.blockedBy || []).map((b) => moved.map[b]).filter(Boolean);
    if (!want.length) continue;
    await o.store.update(o.channel, moved.map[t.id], { blockedBy: want });
    linked++;
  }
  return { moved: Object.keys(moved.map).length, closed: closed.length, linked, map: moved.map };
}

async function refolder(o) {
  const all = await o.store.list(o.channel);
  const hits = all.filter((t) => OPEN.includes(t.status) && t.repo === o.from);
  if (!o.dryRun) for (const t of hits) { await o.store.update(o.channel, t.id, { repo: o.to }); if (o.pauseMs) await new Promise((r) => setTimeout(r, o.pauseMs)); }
  return { changed: hits.map((t) => t.id), open: all.filter((t) => OPEN.includes(t.status)).length };
}

function cli(argv) {
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const to = opt('--to'), stateDir = path.resolve(opt('--state', path.join(os.homedir(), '.office-world'))), channel = opt('--channel', 'office');
  const folder = opt('--folder') ? path.resolve(opt('--folder')) : null;
  if (!to || !/^[\w.-]+\/[\w.-]+$/.test(to)) { console.error('Usage: node relay/move-tickets.js --to owner/repo [--state <folder>] [--channel office] [--folder <repo folder>] [--dry-run]'); process.exit(2); }
  const store = require('./ticket-stores/github.js').open({ repo: channel + '=' + to, keyFile: path.join(stateDir, 'github-store.key'), folder: folder || undefined, cacheMs: 0 });
  if (opt('--refolder')) {
    if (!folder) { console.error('Say the new folder with --folder.'); process.exit(2); }
    const from = opt('--refolder'), dryRun = argv.includes('--dry-run');
    refolder({ store, channel, from, to: folder, dryRun, pauseMs: 500 }).then((r) => {
      console.log((dryRun ? 'Dry run, nothing written. ' : '') + r.changed.length + ' of ' + r.open + ' open tickets in ' + to + (dryRun ? ' would move' : ' moved') + ' from ' + from + ' to ' + folder + '.');
    }, (e) => { console.error('Stopped: ' + e.message + '\nRun it again: tickets already changed are skipped.'); process.exit(1); });
    return;
  }
  const file = path.join(stateDir, 'tickets.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tickets = (data[channel] && data[channel].tickets) || [];
  move({ tickets, store, channel, to, folder, dryRun: argv.includes('--dry-run'), pauseMs: 1000, closedFile: path.join(stateDir, 'tickets-closed.json'), movedFile: path.join(stateDir, 'tickets-moved.json'), say: console.log }).then((r) => {
    if (r.stopped === 'secrets') { console.error('Stopped before writing anything. These tickets look like they hold a secret:'); for (const h of r.hits) console.error('  ' + h.id + ': ' + h.what); process.exit(1); }
    if (r.dryRun) { console.log('Dry run, nothing written. From ' + file + ', channel ' + channel + ':'); console.log('  ' + r.open + ' open tickets would become issues in ' + to + (folder ? ', worked in ' + folder : '') + '.'); console.log('  ' + r.started.length + ' started (' + r.started.join(', ') + ') would come over as ready.'); console.log('  ' + r.blocked + ' have blockers, set again by issue number.'); console.log('  ' + r.closed + ' closed tickets would be saved to ' + path.join(stateDir, 'tickets-closed.json') + '.'); console.log('  The secret check found nothing.'); return; }
    console.log('Moved ' + r.moved + ' tickets to ' + to + ', and set the blockers of ' + r.linked + '. The ' + r.closed + ' closed tickets are in ' + path.join(stateDir, 'tickets-closed.json') + '. Which issue each ticket became: ' + path.join(stateDir, 'tickets-moved.json') + '.');
  }, (e) => { console.error('Stopped: ' + e.message + '\nRun it again to go on from where it stopped.'); process.exit(1); });
}

if (require.main === module) cli(process.argv.slice(2));
module.exports = { move, refolder, secretsIn, fieldsOf };
