// Needs you: one list of what the person has to do now, from state the relay already keeps. relay/needs-you.js
// gathers that state and the Needs you panel on the room page (office/needs-you.js) shows the list. The huddle
// headline (relay/huddles.js) and the Board's Waiting on you column (office/board-model.js) count from the same
// list, so all three agree. A plain function with no side effects, so the tests run it without a relay.
// See docs/manual/roles.html#needs-you.
//
//   listOf({ seats, tasks, waits }) -> [{ kind, who, terminal, task, ticket, pr, line, link }]
//
// A seat is one running session: { terminal, who, role, live, cause, message, screen, task, stuckWhy, spoke, fresh, continuing },
// where live and cause come from relay/liveness.js, screen is 'menu' or 'trust' when a question is on its screen,
// spoke says a turn of it has begun, fresh says it started under a minute ago with no turn yet, and continuing
// says the relay still has a continue prompt for it after a restart cut its turn short (relay/sessions.js).
// A task is one started ticket: { id, ticket, title, state, pr, prOpen, owner, note, reviewRuns, pipelineWaits,
// handedOver, onlyYouMerge }, where owner is the terminal of its Dev while that session runs, and pipelineWaits
// says its open PR's pipeline is running or failing.
// A wait is one saved message (relay/delivery.js) that has not gone in for a long time: { terminal, who, minutes,
// why }, where terminal is the running session it is for, and why says in plain words what holds it.
//
// One rule for each kind. A session gives at most one item, and so does a task. A task whose Dev already has an
// item gives none, since answering the Dev is the one move. The kinds, most urgent first:
//   permission   a session waits on the person, and its message asks for permission
//   question     a session waits on the person for anything else, or a question is on its screen
//   merge        an open PR that only the person may merge
//   handed-over  a task in Waiting on you that Autopilot handed over, with Autopilot's reason
//   waiting      any other task in Waiting on you, unless a review of its PR runs, its pipeline waits, or its
//                Dev is at work
//   stuck        the relay told a session something, and no turn began after it
//   undelivered  a saved message for a running session has waited long, unless that session has another item
//   prompt       an idle Dev on a task in Building or Changes requested with no PR, unless it has just started or
//                the relay still has a continue prompt for it
//   gone         a task in Building or Changes requested with no PR whose session has ended
// link says what the page opens: { terminal } for a session, { url } for a PR, { ticket } for a Board card.
'use strict';
const { oneLine } = require('./clean.js');

const KINDS = ['permission', 'question', 'merge', 'handed-over', 'waiting', 'stuck', 'undelivered', 'prompt', 'gone'];
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

function taskItem(t, dev) {
  const who = dev ? oneLine(dev.who, 40) || 'its Dev' : 'Worker on ' + nameOf(t);
  const pr = t.pr || null;
  const item = (kind, line, link) => ({ kind, who, terminal: dev ? dev.terminal : null, task: t.id, ticket: t.ticket || null, pr, line, link });
  const onPr = pr ? ' (' + nameOf(t) + ')' : '';
  if (t.handedOver && pr) return item('handed-over', 'Decide on PR ' + numberOf(pr) + onPr + ': ' + oneLine(t.handedOver, 300), { url: pr });
  if (t.state === 'waiting_on_you') {
    if (t.reviewRuns || t.pipelineWaits || (dev && BUSY.includes(dev.live))) return null;
    const note = oneLine(t.handedOver || t.note, 300);
    return item('waiting', 'Look at ' + nameOf(t) + ': its task is in Waiting on you.' + (note ? ' ' + note : ''), pr ? { url: pr } : dev ? { terminal: dev.terminal } : { ticket: t.ticket || t.id });
  }
  if (pr && t.prOpen !== false && t.onlyYouMerge) return item('merge', 'Merge PR ' + numberOf(pr) + onPr + ' yourself: ' + oneLine(t.onlyYouMerge, 300), { url: pr });
  if (!dev && BUILDING.includes(t.state) && !pr) return item('gone', 'Bring back the worker on ' + nameOf(t) + ', or move its card: its session ended with no PR.', { ticket: t.ticket || t.id });
  return null;
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
  return items.map((it, i) => [it, i]).sort((a, b) => KINDS.indexOf(a[0].kind) - KINDS.indexOf(b[0].kind) || a[1] - b[1]).map((x) => x[0]);
}

module.exports = { listOf, KINDS };
