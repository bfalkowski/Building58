// Needs you: one list of what the person has to do now, from state the relay already keeps. relay/needs-you.js
// gathers that state and the Needs you panel on the room page (office/needs-you.js) shows the list. The huddle
// headline (relay/huddles.js) and the Board's Waiting on you column (office/board-model.js) count from the same
// list, so all three agree. A plain function with no side effects, so the tests run it without a relay.
// See docs/manual/roles.html#needs-you.
//
//   listOf({ seats, tasks, waits, relays, desks, mains }) -> [{ kind, who, terminal, task, ticket, pr, line, link }]
//
// A seat is one running session: { terminal, who, role, live, cause, message, screen, task, stuckWhy, spoke, fresh, continuing },
// where live and cause come from relay/liveness.js, screen is 'menu' or 'trust' when a question is on its screen,
// spoke says a turn of it has begun, fresh says it started under a minute ago with no turn yet, and continuing
// says the relay still has a continue prompt for it after a restart cut its turn short (relay/sessions.js).
// A task is one started ticket: { id, ticket, title, state, pr, prOpen, owner, note, reviewRuns, pipelineWaits,
// handedOver, devSaysBug, reviewedSince, onlyYouMerge, reviewFailed }, where owner is the terminal of its Dev while
// that session runs, pipelineWaits says its open PR's pipeline is running or failing, devSaysBug says Autopilot handed
// it over because its Dev says a finding the merge review marked non-blocking is a bug, reviewedSince is the last
// review posted after Autopilot handed it over because nothing moved it: { kind, commit, url, current }, where current
// says the PR's head is that commit, and reviewFailed is why its PR's automatic review could not start, once the
// relay stopped trying.
// A wait is one saved message (relay/delivery.js) that has not gone in for a long time: { terminal, who, minutes,
// why }, where terminal is the running session it is for, and why says in plain words what holds it.
// A relay is another relay on this room's state folder (relay/old-relays.js): { pid, file, port, started, paused, worker }.
// desks is reviews that wait for a desk while the relay may stop no session: { prs, taken }, the longest wait first.
// A main is one base branch whose latest CI run failed (relay/main-ci.js): { name, branch, run: { workflow, sha, url, conclusion } }.
//
// One rule for each kind. A session gives at most one item, and so does a task. A task whose Dev already has an
// item gives none, since answering the Dev is the one move. The kinds, most urgent first:
//   relay        another relay uses this room's state folder, so it can erase what this relay saves
//   permission   a session waits on the person, and its message asks for permission
//   question     a session waits on the person for anything else, or a question is on its screen
//   desks        reviews wait for a desk, and the relay may stop none of the sessions that hold them all
//   main         the latest push run of CI on main failed, so Autopilot starts no new ticket on that branch
//   merge        an open PR that only the person may merge
//   handed-over  a task in Waiting on you that Autopilot handed over, with Autopilot's reason, or, for a stall,
//                with the next step a review posted after it gives
//   review       an open PR whose automatic review could not start, with the reason, unless a review of it runs
//   waiting      any other task in Waiting on you, unless a review of its PR runs, its pipeline waits, or its
//                Dev is at work
//   stuck        the relay told a session something, and no turn began after it
//   undelivered  a saved message for a running session has waited long, unless that session has another item
//   prompt       an idle Dev on a task in Building or Changes requested with no PR, unless it has just started or
//                the relay still has a continue prompt for it
//   gone         a task in Building or Changes requested with no PR whose session has ended
// link says what the page opens: { terminal } for a session, { url } for a PR, { ticket } for a Board card,
// and { stop } for another relay, its pid, which the page's Stop button stops. A hand-over whose Dev says a finding
// is a bug also has { fix }, its task's id, which the page's Fix it button sends to POST /autopilot/fix.
'use strict';
const { oneLine } = require('./clean.js');

const KINDS = ['relay', 'permission', 'question', 'desks', 'main', 'merge', 'handed-over', 'review', 'waiting', 'stuck', 'undelivered', 'prompt', 'gone'];
const BUILDING = ['building', 'changes_requested'];
const BUSY = ['working', 'quiet', 'job'];
const PERMISSION = /permission/i;

const numberOf = (pr) => '#' + String(pr).split('/').pop();
const nameOf = (t) => oneLine(t.ticket, 20) || 'task ' + oneLine(t.id, 20);

function seatItem(s, t) {
  const who = oneLine(s.who, 40) || 'a session';
  const item = (kind, line) => ({ kind, who, terminal: s.terminal, task: t ? t.id : null, ticket: t ? t.ticket || null : null, pr: t ? t.pr || null : null, line, link: { terminal: s.terminal } });
  if (s.live === 'gone') return null;
  const message = oneLine(s.message, 200);
  if (s.live === 'waiting' && PERMISSION.test(message)) return item('permission', 'Approve or deny the request from ' + who + ': ' + message);
  if (s.live === 'waiting') return item('question', 'Answer ' + who + ': ' + (message || 'it waits on you.'));
  if (s.screen === 'trust') return item('question', 'Answer the question on the screen of ' + who + ': does it trust this folder?');
  if (s.screen === 'menu') return item('question', 'Answer the question on the screen of ' + who + '.');
  if (s.live === 'stuck' && s.cause === 'told') return item('stuck', 'Open the session of ' + who + ': the relay told it something and it did not start' + (s.stuckWhy ? ', ' + oneLine(s.stuckWhy, 160) : '') + '.');
  if (s.role === 'Dev' && s.live === 'idle' && !s.fresh && !s.continuing && t && BUILDING.includes(t.state) && !t.pr) return item('prompt', 'Prompt ' + who + ': ' + (s.spoke === false ? 'it has not started on ' + nameOf(t) + '.' : 'it stopped on ' + nameOf(t) + ' with no PR.'));
  return null;
}

function reviewedLine(t, dev, item) {
  const r = t.reviewedSince, pr = t.pr, n = numberOf(pr), at = oneLine(r.commit, 40).slice(0, 7), url = oneLine(r.url, 300);
  const where = url ? ' ' + url : '';
  if (r.current === false) return item('handed-over', 'Get a review of PR ' + n + ' (' + nameOf(t) + '): the review of ' + at + ' says ' + (r.kind === 'merge' ? 'merge' : 'fix') + ', but newer commits came after it.', { url: pr });
  if (r.kind === 'merge') return item('handed-over', 'Merge PR ' + n + ' (' + nameOf(t) + '), or move its card: the review of ' + at + ' says merge.' + where, { url: pr });
  if (!dev) return item('handed-over', 'Bring back the worker on ' + nameOf(t) + ' to fix PR ' + n + ': the review of ' + at + ' says fix, and its session has ended.' + where, { ticket: t.ticket || t.id });
  return item('handed-over', 'Move ' + nameOf(t) + ' out of Waiting on you: the review of ' + at + ' on PR ' + n + ' says fix, and ' + (oneLine(dev.who, 40) ? 'its Dev ' + oneLine(dev.who, 40) : 'its Dev') + ' is running to fix it.' + where, { ticket: t.ticket || t.id });
}

function taskItem(t, dev) {
  const who = dev ? oneLine(dev.who, 40) || 'its Dev' : 'Worker on ' + nameOf(t);
  const pr = t.pr || null;
  const item = (kind, line, link) => ({ kind, who, terminal: dev ? dev.terminal : null, task: t.id, ticket: t.ticket || null, pr, line, link });
  const onPr = pr ? ' (' + nameOf(t) + ')' : '';
  if (t.handedOver && pr && t.reviewedSince) return reviewedLine(t, dev, item);
  if (t.handedOver && pr) return item('handed-over', 'Decide on PR ' + numberOf(pr) + onPr + ': ' + oneLine(t.handedOver, 300), t.devSaysBug ? { url: pr, fix: t.id } : { url: pr });
  if (pr && t.prOpen !== false && t.reviewFailed && !t.reviewRuns) return item('review', 'Get a review of PR ' + numberOf(pr) + onPr + ': its automatic review could not start, and the relay stopped trying. ' + oneLine(t.reviewFailed, 400), dev ? { terminal: dev.terminal } : { url: pr });
  if (t.state === 'waiting_on_you') {
    if (t.reviewRuns || t.pipelineWaits || (dev && BUSY.includes(dev.live))) return null;
    const note = oneLine(t.handedOver || t.note, 300);
    return item('waiting', 'Look at ' + nameOf(t) + ': its task is in Waiting on you.' + (note ? ' ' + note : ''), pr ? { url: pr } : dev ? { terminal: dev.terminal } : { ticket: t.ticket || t.id });
  }
  if (pr && t.prOpen !== false && t.onlyYouMerge) return item('merge', 'Merge PR ' + numberOf(pr) + onPr + ' yourself: ' + oneLine(t.onlyYouMerge, 300), { url: pr });
  if (!dev && BUILDING.includes(t.state) && !pr) return item('gone', 'Bring back the worker on ' + nameOf(t) + ', or move its card: its session ended with no PR.', { ticket: t.ticket || t.id });
  return null;
}

const MAY_STOP = 'It stops only a reviewer whose review is posted, or an idle Dev whose PR merged, whose task is Done, or whose PR waits on a review.';
function desksItem(d) {
  const prs = ((d && d.prs) || []).filter((pr) => typeof pr === 'string');
  if (!prs.length) return null;
  const named = prs.map(numberOf), list = named.length > 1 ? named.slice(0, -1).join(', ') + ' and ' + named[named.length - 1] : named[0];
  const taken = Math.max(0, Math.floor(Number(d.taken) || 0));
  return { kind: 'desks', who: 'the relay', terminal: null, task: null, ticket: null, pr: prs[0],
    line: 'Stop a session to free a desk: the review' + (prs.length > 1 ? 's of PR ' + list + ' wait' : ' of PR ' + list + ' waits') + ' for one. All ' + taken + ' desks are taken, and the relay may stop none of them. ' + MAY_STOP, link: {} };
}

function redMain(m) {
  const r = m.run || {}, branch = oneLine(m.branch, 80) || 'main', sha = oneLine(r.sha, 64).slice(0, 7), url = oneLine(r.url, 300);
  return branch + ' of ' + (oneLine(m.name, 80) || 'the repo') + ': ' + (oneLine(r.workflow, 80) || 'CI') + (sha ? ' at ' + sha : '') + ' ended in ' + (oneLine(r.conclusion, 40).replace(/_/g, ' ') || 'failure') + '. Autopilot starts no new ticket on ' + branch + ' there until a push run on ' + branch + ' passes.' + (url ? ' ' + url : '');
}

function listOf(input) {
  const seats = (input && input.seats) || [], tasks = ((input && input.tasks) || []).filter((t) => t && t.state !== 'done');
  const items = [], covered = new Set();
  for (const s of seats) {
    const t = s.task ? tasks.find((x) => x.id === s.task) || null : null;
    const it = seatItem(s, t);
    if (!it) continue;
    items.push(it);
    if (t) covered.add(t.id);
  }
  for (const t of tasks) {
    if (covered.has(t.id)) continue;
    const dev = t.owner ? seats.find((s) => s.terminal === t.owner && s.live !== 'gone') || null : null;
    if (dev && items.some((i) => i.terminal === dev.terminal)) continue;
    const it = taskItem(t, dev);
    if (it) items.push(it);
  }
  for (const w of (input && input.waits) || []) {
    if (!w || !w.terminal || items.some((i) => i.terminal === w.terminal)) continue;
    const who = oneLine(w.who, 40) || 'a session';
    const minutes = Math.max(1, Math.floor(Number(w.minutes) || 0));
    items.push({ kind: 'undelivered', who, terminal: w.terminal, task: null, ticket: null, pr: null, line: 'Open the session of ' + who + ': a message from the relay has waited ' + minutes + (minutes === 1 ? ' minute' : ' minutes') + ' for it and is not typed in, because ' + (oneLine(w.why, 160) || 'the relay cannot tell why') + '.', link: { terminal: w.terminal } });
  }
  for (const r of (input && input.relays) || []) {
    const pid = Number(r && r.pid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const from = oneLine(r.file, 200), port = Number(r.port) || null, started = oneLine(r.started, 40).slice(0, 16).replace('T', ' ');
    const where = [from ? 'it runs ' + from : '', port ? 'on port ' + port : '', started ? 'since ' + started + ' UTC' : ''].filter(Boolean).join(' ');
    const how = r.paused ? ' It is paused, and can wake up later.' : r.worker === false ? ' It has no relay process left to answer, only its supervisor.' : '';
    items.push({ kind: 'relay', who: 'relay ' + pid, terminal: null, task: null, ticket: null, pr: null, line: 'Stop the other relay, pid ' + pid + (where ? ': ' + where : '') + '. It uses this room\'s state folder, so it can erase what this relay saves.' + how, link: { stop: pid } });
  }
  const desks = desksItem(input && input.desks);
  if (desks) items.push(desks);
  for (const m of (input && input.mains) || []) {
    if (!m || !m.run) continue;
    const url = oneLine(m.run.url, 300);
    items.push({ kind: 'main', who: 'CI', terminal: null, task: null, ticket: null, pr: null, line: 'Look at the failed CI run on ' + redMain(m), link: url ? { url } : {} });
  }
  return items.map((it, i) => [it, i]).sort((a, b) => KINDS.indexOf(a[0].kind) - KINDS.indexOf(b[0].kind) || a[1] - b[1]).map((x) => x[0]);
}

module.exports = { listOf, redMain, KINDS };
