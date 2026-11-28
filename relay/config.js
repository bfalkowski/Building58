'use strict';
const fs = require('fs');
const path = require('path');
const state = require('./state.js');
const skills = require('./skills.js');

const FILE = state.file('settings.json', 'RELAY_SETTINGS_FILE');

const TABS = [
  { id: 'trust', label: 'Trust', about: 'How much the room may do on its own.' },
  { id: 'autopilot', label: 'Autopilot', about: 'How it starts and merges.' },
  { id: 'reviews', label: 'Reviews and PRs', about: 'Reviewers and the PR watch.' },
  { id: 'roles', label: 'Roles', about: 'Models, skills, the PM and the officers.' },
  { id: 'room', label: 'Room', about: 'Sessions and updates.' },
  { id: 'chat', label: 'Chat', about: 'Channels and huddles.' },
  { id: 'advanced', label: 'Advanced', about: 'How often the relay checks GitHub and the Lead.' }
];

const SETTINGS = [
  { name: 'wipLimit', group: 'Work', tab: 'autopilot', label: 'WIP limit', unit: 'tasks', env: 'RELAY_WIP_LIMIT', def: 3, min: 1, max: 10,
    what: 'The most tasks that can be building at the same time. When this many are building, the relay refuses Start, Bring back, the Lead\'s starts and Autopilot\'s starts.' },
  { name: 'readyMinutes', group: 'Work', tab: 'room', label: 'Wait for a new session for', unit: 'minutes', env: 'RELAY_READY_LIMIT', scale: 1 / 60000, def: 10, min: 1, max: 60,
    what: 'How long the relay waits for a new session to be ready for its brief. After this time, the relay stops waiting and says so.' },
  { name: 'leadCheckMinutes', group: 'Work', tab: 'advanced', label: 'Lead heartbeat every', unit: 'minutes', env: 'RELAY_LEAD_CHECK_MS', scale: 1 / 60000, def: 60, min: 0, max: 240, zero: true,
    what: 'The relay prompts the Lead when something new is stuck that the Lead or the person owns: a jam, a hand-over, a red main, a Dev that went quiet. This is the slow heartbeat: this often it prompts the Lead again about items that are still open and that it was told about. With nothing stuck, the Lead is never prompted. It waits until the Lead is idle, and a prompt that comes due while one still waits is dropped. 0 stops the heartbeat, not the event prompts.' },
  { name: 'githubPassSeconds', group: 'Reviews', tab: 'advanced', label: 'GitHub pass every', unit: 'seconds', env: 'RELAY_GITHUB_PASS_SECONDS', def: 60, min: 10, max: 3600,
    what: 'How often the one GitHub pass reads every open task PR, with one call for each repo. Autopilot, the pipeline, the PR watch and chat read the PR from it. It also runs when a task changes state. A check that must be fresh, such as the one before a merge, still asks GitHub itself.' },
  { name: 'updateHoldMinutes', group: 'Work', tab: 'room', label: 'Hold messages for an update for', unit: 'minutes', env: 'RELAY_UPDATE_HOLD_MS', scale: 1 / 60000, def: 10, min: 0, max: 600, zero: true,
    what: 'While an update waits for a quiet moment, the relay types no saved message for this long, counted from when the wait began, so that sessions can finish their turns and the update can restart the relay. After that, saved messages go in, and the update waits for their turns too. First briefs and first prompts are never held this way. 0 holds nothing.' },
  { name: 'updateWaitMinutes', group: 'Work', tab: 'room', label: 'Update waits at most', unit: 'minutes', env: 'RELAY_UPDATE_WAIT_MS', scale: 1 / 60000, def: 30, min: 1, max: 1440,
    what: 'An update that has fetched new relay code waits for a moment with no session in a turn. After this long it restarts the relay anyway, once no tool call is in progress or after a minute at most. The sessions keep running in the session host, and the new relay takes each one back, so a turn in progress runs on through it.' },
  { name: 'updateForcedMinutes', group: 'Work', tab: 'room', label: 'Forced restarts at most every', unit: 'minutes', env: 'RELAY_UPDATE_FORCED_MS', scale: 1 / 60000, def: 60, min: 1, max: 1440,
    what: 'The most often an update restarts the relay before the room is quiet. A merge that comes in sooner waits for this time to pass, and goes in with the other merges since, in one restart. A restart at a quiet moment is never held back by this.' },
  { name: 'stallMinutes', group: 'Work', tab: 'room', label: 'A session is stuck after', unit: 'minutes', env: 'RELAY_STALL_MS', scale: 1 / 60000, def: 30, min: 5, max: 600,
    what: 'A session in a turn that sends no hook and prints nothing for this long is stuck. If it still prints, it is quiet instead, since Claude Code\'s spinner prints while it thinks. The Floor, Autopilot and the COO all use this time (relay/liveness.js).' },
  { name: 'keepAwake', group: 'Work', tab: 'room', label: 'Keep the computer awake', kind: 'bool', env: 'RELAY_KEEP_AWAKE', def: true,
    what: 'While a task is building, has changes requested or is in review, or Autopilot is on, the relay keeps the Mac from sleeping, with its own caffeinate tool. It stops when the room has no work left, and when the relay stops. After the Mac wakes from a sleep, each session whose turn the sleep cut off is told once to carry on. The display may still sleep. On a computer that is not a Mac, this does nothing.' },
  { name: 'games', group: 'Work', tab: 'room', label: 'Games', kind: 'bool', env: 'RELAY_GAMES', def: false,
    what: 'Rounds that act out a game or a simulation from another repo (GAMES_REPO), with a fresh session for each seat. They are not done yet, so this is off: the Games panel is hidden, and the relay starts no round and no seat session. Turn it on to try a round.' },
  { name: 'leadStops', group: 'The Lead', tab: 'trust', label: 'Let the Lead stop sessions', kind: 'bool', env: 'RELAY_LEAD_STOPS', def: false,
    what: 'The Lead can stop a session that is done or idle, with ticket.js stop. The relay first checks that the session is safe to stop. The Lead must also have Let the Lead move the board. Like Let the Lead set priority, and unlike Let the Lead move the board, this one stays on when you make a different session the Lead.' },
  { name: 'leadStopLimit', group: 'The Lead', tab: 'roles', label: 'Lead stops an hour', unit: 'stops', env: 'RELAY_LEAD_STOP_LIMIT', def: 6, min: 1, max: 60,
    what: 'The most sessions that the Lead can stop in one hour, on each channel. After that, the Lead gives the other sessions to you to stop.' },
  { name: 'leadOrder', group: 'The Lead', tab: 'trust', label: 'Let the Lead set priority', kind: 'bool', def: false,
    what: 'The Lead can set the priority and the place in the work order of tickets in Triage or Ready, with ticket.js priority and ticket.js order. It is apart from Let the Lead move the board, and does not let the Lead start a ticket or change a status. It stays on when you make a different session the Lead, and then only the new Lead can use it. The Board shows who last set each ticket\'s priority or place, and your change wins.' },
  { name: 'leadUnstick', group: 'The Lead', tab: 'trust', label: 'Let the Lead unstick the board', kind: 'bool', def: false,
    what: 'On each pass the Lead works through stuck work before anything else, and reports to you only what it cannot do. It opens and runs the shared channel for a failure that blocks two or more PRs, links and merges the duplicate tickets of that failure, and, only while no blocked Dev runs, sets the ticket high and first, even with Let the Lead set priority off, and starts it with a new Dev (which still needs Let the Lead move the board and start tickets). It reruns a known-flaky failed job once, and fixes the stalls you fix by hand through the routes that exist, and writes each fix in the jam log with by: Lead. It never merges, and a stuck item it reported three passes in a row with no action goes on Needs you. It stays on when you make a different session the Lead.' },
  { name: 'leadReviews', group: 'The Lead', tab: 'trust', label: 'Let the Lead start reviews', kind: 'bool', def: false,
    what: 'The Lead can ask the relay for a review of a task\'s PR, with ticket.js review, as you would with Get a review. The relay refuses a PR that is not a task\'s, one with a reviewer running, and an ask with no desk free. These reviews count toward Automatic reviews per PR, so the loop stops there. The Lead never reviews in its own session. While Autopilot is on, the Lead can start reviews whatever this switch says.' },
  { name: 'maxAutoReviews', group: 'Reviews', tab: 'reviews', label: 'Automatic reviews per PR', unit: 'reviews', def: 3, min: 1, max: 10,
    what: 'The most reviews the relay starts for one PR: the automatic ones, the first one included, and those the Lead asks for. After that, a push gets no review until you press Get a review.' },
  { name: 'reviewPollSeconds', group: 'Reviews', tab: 'advanced', label: 'Check PRs for comments every', unit: 'seconds', env: 'RELAY_REVIEW_POLL_SECONDS', def: 60, min: 0, max: 3600, zero: true,
    what: 'How often the relay asks GitHub for new comments on each PR, to send them to the Dev. 0 stops it.' },
  { name: 'pipelinePollSeconds', group: 'Reviews', tab: 'advanced', label: 'Check each PR\'s pipeline every', unit: 'seconds', env: 'RELAY_PIPELINE_POLL_SECONDS', def: 15, min: 0, max: 600, zero: true,
    what: 'How often the relay asks GitHub for the checks on each open PR. An automatic review waits until they pass, and the Board shows a PR whose checks are running or failed as waiting on the pipeline. 0 stops asking, and reviews start without waiting.' },
  { name: 'mainCiPollSeconds', group: 'Reviews', tab: 'advanced', label: 'Check main\'s CI every', unit: 'seconds', env: 'RELAY_MAIN_CI_POLL_SECONDS', def: 120, min: 0, max: 3600, zero: true,
    what: 'How often the relay asks GitHub for the latest CI runs that a push to main started, once for each repo and base branch the room works on. When the latest one failed, Needs you and the Lead\'s Floor say main is red, and Autopilot starts no new ticket on that branch until a push run passes. 0 stops asking, and then nothing shows main as red.' },
  { name: 'pipelineNoChecksSeconds', group: 'Reviews', tab: 'reviews', label: 'Review a PR with no checks after', unit: 'seconds', env: 'RELAY_PIPELINE_NO_CHECKS_MS', scale: 1 / 1000, def: 120, min: 10, max: 3600,
    what: 'GitHub can take a moment to start a PR\'s checks. A PR with none waits this long for them, then its review starts with no pipeline. The same happens when gh cannot read the checks.' },
  { name: 'reviewRetrySeconds', group: 'Reviews', tab: 'reviews', label: 'Try a review again after', unit: 'seconds', env: 'RELAY_REVIEW_RETRY_MS', scale: 1 / 1000, def: 60, min: 5, max: 3600,
    what: 'If a follow-up review cannot start, for example because all desks are full, the relay waits this long and tries again. It tries 3 times. A first review tries 3 times this way too, but when only a desk is missing it waits for a free desk instead.' },
  { name: 'reviewGraceSeconds', group: 'Reviews', tab: 'reviews', label: 'A reviewer leaves after', unit: 'seconds', env: 'RELAY_REVIEW_GRACE_MS', scale: 1 / 1000, def: 30, min: 1, max: 600,
    what: 'After an automatic reviewer posts and its turn ends, the relay waits this long, then ends the session and frees its desk.' },
  { name: 'autopilotExhibit', group: 'Autopilot', tab: 'autopilot', label: 'Merge only when Exhibit passes', kind: 'bool', def: false,
    what: 'Level 6. Autopilot also needs the verdict that the nightly Exhibit run stored for the PR\'s head commit (on the exhibit-data branch) to say meets_policy before it merges. It waits while none is stored for the current head, and hands the PR to you when Exhibit says needs_person or error. The nightly run must have checked the PR, or Autopilot never merges it. Off by default.' },
  { name: 'autopilotRounds', group: 'Autopilot', tab: 'autopilot', label: 'Review rounds', unit: 'rounds', def: 2, min: 1, max: 5,
    what: 'If this many reviews in a row still ask for fixes, Autopilot stops and puts the task in Waiting on you.' },
  { name: 'autopilotMerges', group: 'Autopilot', tab: 'autopilot', label: 'Merges a day', unit: 'merges', def: 10, min: 1, max: 50,
    what: 'The most PRs that Autopilot merges in one day. After that, a PR that is ready waits for you or for the next day.' },
  { name: 'autopilotMainMerges', group: 'Autopilot', tab: 'autopilot', label: 'Merges of main in a row', unit: 'merges', def: 4, min: 1, max: 20,
    what: 'A Dev that merges main as asked is not failing when main moves again and the PR conflicts again. Autopilot asks again. If this many merges of main in a row each conflicted again, it puts the task in Waiting on you and says main kept moving.' },
  { name: 'autopilotAtOnce', group: 'Autopilot', tab: 'autopilot', label: 'Tickets at once', unit: 'tickets', env: 'RELAY_AUTOPILOT_AT_ONCE', def: 1, min: 1, max: 5,
    what: 'How many tasks Autopilot works on at the same time. The WIP limit also applies.' },
  { name: 'autopilotStallMinutes', group: 'Autopilot', tab: 'autopilot', label: 'Give you a stuck task after', unit: 'minutes', env: 'RELAY_AUTOPILOT_STALL_MS', scale: 1 / 60000, def: 30, min: 5, max: 1440,
    what: 'If an Autopilot task is stuck this long, Autopilot puts it in Waiting on you and can start the next ticket. Stuck means its Dev or a reviewer is at a question, a reviewer never started, or nothing running could move it.' },
  { name: 'autopilotTickSeconds', group: 'Autopilot', tab: 'advanced', label: 'Check every', unit: 'seconds', env: 'RELAY_AUTOPILOT_TICK_MS', scale: 1 / 1000, def: 20, min: 5, max: 600,
    what: 'How often Autopilot checks its PRs and the Ready column.' },
  { name: 'prWatch', group: 'PR watch', tab: 'reviews', label: 'Watch each open PR', kind: 'bool', def: false,
    what: 'Every few minutes the relay reads each open task PR from GitHub and its Dev\'s session and checkout, and moves it to its next step: it asks for a review of a head no review read, tells the Dev once about blocking findings, a conflict with main, a failed check or commits it has not pushed, and tells the Lead when a PR is reviewed, green and clean. It merges nothing.' },
  { name: 'prWatchSeconds', group: 'PR watch', tab: 'advanced', label: 'Watch PRs every', unit: 'seconds', env: 'RELAY_PR_WATCH_SECONDS', def: 120, min: 30, max: 3600,
    what: 'How often the PR watch reads each open task PR.' },
  { name: 'prWatchWaitMinutes', group: 'PR watch', tab: 'reviews', label: 'Give you a PR that waits after', unit: 'minutes', env: 'RELAY_PR_WATCH_WAIT_MS', scale: 1 / 60000, def: 60, min: 5, max: 1440,
    what: 'A PR that has waited this long on its Dev, a reviewer, CI or the Lead shows as waiting on you, and the chat board says so once.' },
  { name: 'managerWatchSeconds', group: 'The manager', tab: 'roles', label: 'The manager looks for stuck work every', unit: 'seconds', env: 'RELAY_MANAGER_WATCH_SECONDS', def: 60, min: 10, max: 3600, zero: true,
    what: 'How often the relay looks for signs that work is stuck. The manager then says what it finds in Activity and at the desk it is about, and files one ticket for each new problem. The watch only reads. 0 stops it.' },
  { name: 'managerLowersTrust', group: 'The manager', tab: 'trust', label: 'Let the manager lower the trust level', kind: 'bool', def: false,
    what: 'While this is on and the manager\'s watch finds a stall that work cannot get past (the same check failing on commit after commit, or Autopilot handing task after task to you; one already there when you turn this on does not count), the relay lowers the trust level by one, for example from Autopilot (5) to the Lead merges (4). It only lowers, never raises. It lowers at most twice in 24 hours, and then leaves the rest to you. Activity, Settings and the manager\'s bubble say what he saw and which level he moved to. Work under way stays where it is and nothing new starts. It reverts no PR, reopens or rejects no ticket and stops no session.' },
  { name: 'managerBuildingMinutes', group: 'The manager', tab: 'roles', label: 'A task in Building is stuck after', unit: 'minutes', env: 'RELAY_MANAGER_BUILDING_MS', scale: 1 / 60000, def: 60, min: 5, max: 1440,
    what: 'A task in Building that has had no hook, push or PR change for this long. A Dev that waits at a question is not counted: the question is yours.' },
  { name: 'managerCheckFails', group: 'The manager', tab: 'roles', label: 'The same check is failing after', unit: 'commits', env: 'RELAY_MANAGER_CHECK_FAILS', def: 3, min: 2, max: 20,
    what: 'The same check on one PR has failed on this many commits in a row.' },
  { name: 'managerBriefMinutes', group: 'The manager', tab: 'roles', label: 'A session never got its first prompt after', unit: 'minutes', env: 'RELAY_MANAGER_BRIEF_MS', scale: 1 / 60000, def: 10, min: 1, max: 240,
    what: 'A Dev that has not got its brief, or a reviewer that has not got its first prompt, this long after the session started.' },
  { name: 'managerSlotMinutes', group: 'The manager', tab: 'roles', label: 'A building slot with no Dev is stuck after', unit: 'minutes', env: 'RELAY_MANAGER_SLOT_MS', scale: 1 / 60000, def: 10, min: 1, max: 240,
    what: 'A task that holds a building slot while no Dev is running for it, for this long.' },
  { name: 'managerHandoffs', group: 'The manager', tab: 'roles', label: 'Autopilot hands you tasks in a row after', unit: 'tasks', env: 'RELAY_MANAGER_HANDOFFS', def: 3, min: 2, max: 20,
    what: 'Autopilot has put this many tasks in a row into Waiting on you, with no merge between them.' },
  { name: 'managerSkipMinutes', group: 'The manager', tab: 'roles', label: 'A Ready ticket is skipped for a rejected blocker after', unit: 'minutes', env: 'RELAY_MANAGER_SKIP_MS', scale: 1 / 60000, def: 30, min: 1, max: 1440,
    what: 'Autopilot is on, and a ticket in Ready has had a rejected ticket among its blockers for this long, so Autopilot will never start it.' },
  { name: 'chatKeep', group: 'Chat and huddles', tab: 'chat', label: 'Posts kept in each chat channel', unit: 'posts', env: 'RELAY_CHAT_KEEP', def: 200, min: 10, max: 5000,
    what: 'How many posts each chat channel keeps. The relay deletes older posts.' },
  { name: 'chatPollSeconds', group: 'Chat and huddles', tab: 'advanced', label: 'Check GitHub for the chat every', unit: 'seconds', env: 'RELAY_CHAT_POLL_SECONDS', def: 60, min: 0, max: 3600, zero: true,
    what: 'How often the relay asks GitHub about PRs, to post their news on the chat board. 0 stops it.' },
  { name: 'mainPollSeconds', group: 'Chat and huddles', tab: 'advanced', label: 'Check whether main moved every', unit: 'seconds', env: 'RELAY_MAIN_POLL_SECONDS', def: 60, min: 0, max: 3600, zero: true,
    what: 'How often the relay asks origin where its default branch points, with git ls-remote in the relay\'s folder, to say in #office when it moved. 0 stops it.' },
  { name: 'chatRetrySeconds', group: 'Chat and huddles', tab: 'chat', label: 'Try a chat mention again after', unit: 'seconds', env: 'RELAY_CHAT_RETRY_MS', scale: 1 / 1000, def: 30, min: 5, max: 600,
    what: 'If a session was busy when someone mentioned it in the chat, the relay tries again to give it the mention after this long.' },
  { name: 'huddleAnswerSeconds', group: 'Chat and huddles', tab: 'chat', label: 'Wait for huddle answers for', unit: 'seconds', env: 'RELAY_HUDDLE_ANSWER_SECONDS', def: 180, min: 30, max: 1800,
    what: 'How long a huddle waits for each session to answer. After this time, the report shows the session with no answer.' },
  { name: 'cooGraceSeconds', group: 'COO and PM', tab: 'roles', label: 'The COO leaves after', unit: 'seconds', env: 'RELAY_COO_GRACE_MS', scale: 1 / 1000, def: 10, min: 1, max: 600,
    what: 'After the COO saves its report and its turn ends, the relay waits this long, then ends the COO\'s session.' },
  { name: 'securityGraceSeconds', group: 'COO and PM', tab: 'roles', label: 'The security officer leaves after', unit: 'seconds', env: 'RELAY_SECURITY_GRACE_MS', scale: 1 / 1000, def: 10, min: 1, max: 600,
    what: 'After the security officer saves its report and its turn ends, the relay waits this long, then ends its session.' },
  { name: 'pmTrust', group: 'COO and PM', tab: 'trust', label: 'PM trust', unit: 'rung', env: 'RELAY_PM_TRUST', def: 1, min: 0, max: 4, zero: true,
    what: 'How much the PM may do about the ticket Autopilot is about to start. Each rung does everything the rungs below it do. 0 Off: no check. 1 Advise: the PM checks each ticket and writes its view on the ticket, and Autopilot starts it anyway. 2 Hold and propose: when the PM says not needed, duplicate or part of another ticket, the ticket does not start and the PM files a proposal for you to approve; when it says another first, Autopilot checks that ticket next. 3 Order: the PM may also set the priority and place of tickets in Triage or Ready, with ticket.js priority and ticket.js order. 4 Close and merge: the PM carries out its own close, replace and merge, and writes on the ticket what it did and why. Only you change the rung, and your change to a ticket wins. If more than one PM is running, only the newest counts.' },
  { name: 'pmCheckMinutes', group: 'COO and PM', tab: 'roles', label: 'Wait for the PM\'s check for', unit: 'minutes', env: 'RELAY_PM_CHECK_MS', scale: 1 / 60000, def: 10, min: 1, max: 120,
    what: 'How long Autopilot waits for the PM to answer its check of a ticket. If the PM does not answer in time, or no PM is running, Autopilot starts the ticket and says so in its notes.' },
  { name: 'pmSortHours', group: 'COO and PM', tab: 'roles', label: 'PM sorts the Board every', unit: 'hours', env: 'RELAY_PM_SORT_HOURS', def: 0, min: 0, max: 168, zero: true,
    what: 'How often the relay asks the PM to look at every Triage and Ready ticket, do what its PM trust rung allows, and post a short summary in the chat. It asks only while no ticket is starting, and only of a PM that is running. At rung 1 the PM only writes advice, and at rung 0 (Off) nothing is asked. 0 stops it.' },
  { name: 'pmTalkMinutes', group: 'COO and PM', tab: 'roles', label: 'Keep the PM after you type for', unit: 'minutes', env: 'RELAY_PM_TALK_MINUTES', def: 30, min: 1, max: 600,
    what: 'After you type to the PM, nobody can stop the PM as idle for this long.' },
  ...[['lead', 'The Lead', 'pstack:recall'],
    ['dev', 'Devs', 'mattpocock-skills:tdd, mattpocock-skills:diagnosing-bugs, mattpocock-skills:codebase-design, pstack:blast-radius, pstack:principle-prove-it-works, mattpocock-skills:pr'],
    ['reviewer', 'Reviewers', 'mattpocock-skills:code-review, pstack:blast-radius'],
    ['pm', 'The PM', 'pstack:sharpen, mattpocock-skills:writing-for-agents'],
    ['coo', 'The COO', 'pstack:principle-explain-the-number'],
    ['security', 'The security officer', 'pstack:principle-explain-the-number']].flatMap(([role, who, def]) => [
    { name: role + 'Model', group: 'Models and skills', tab: 'roles', label: who + ': model', kind: 'text', def: '', check: skills.modelOk, rule: 'is empty, or a model name such as opus, sonnet, haiku or a full model id: letters, digits, dots, dashes and brackets, up to 64.',
      what: 'The model a new session runs on, as with claude --model. Empty: your own default. A session brought back with its conversation keeps the model it had.' },
    { name: role + 'Skills', group: 'Models and skills', tab: 'roles', label: who + ': skills', kind: 'skills', def, check: skills.skillsOk, about: skills.about, rule: 'is empty, or up to 12 skill names such as mattpocock-skills:tdd, split by commas or spaces.',
      what: 'Skills its brief names, where they fit. Only the ones installed here go in. Empty: the brief names none.' }])
];
const BY_NAME = new Map(SETTINGS.map((s) => [s.name, s]));

let saved = {};
try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { saved = {}; }
const switchedOn = saved.pmOrder === true && !Object.prototype.hasOwnProperty.call(saved, 'pmTrust');
if (Object.prototype.hasOwnProperty.call(saved, 'pmOrder')) {
  if (switchedOn) saved.pmTrust = 3;
  delete saved.pmOrder;
}
function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(saved, null, 2) + '\n');
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) { console.error('Could not save the settings to ' + FILE + ': ' + e.message); }
}

function valid(s, v) {
  if (s.check) return s.check(v);
  if (s.kind === 'bool') return typeof v === 'boolean';
  return typeof v === 'number' && Number.isInteger(v) && v >= s.min && v <= s.max;
}
function fromEnv(s) {
  const raw = s.env ? process.env[s.env] : undefined;
  if (raw === undefined) return undefined;
  if (raw === '') return s.zero ? 0 : undefined;
  if (s.kind === 'bool') return raw === '1';
  const n = Number(raw) * (s.scale || 1);
  return Number.isFinite(n) && (n > 0 || (s.zero && n === 0)) ? n : undefined;
}
function sourceOf(s) {
  if (Object.prototype.hasOwnProperty.call(saved, s.name) && valid(s, saved[s.name])) return 'page';
  return fromEnv(s) !== undefined ? 'env' : 'default';
}
function get(name) {
  const s = BY_NAME.get(name);
  if (!s) throw new Error('No setting ' + name);
  const from = sourceOf(s);
  return from === 'page' ? saved[name] : from === 'env' ? fromEnv(s) : s.def;
}
const list = () => SETTINGS.map((s) => ({ name: s.name, group: s.group, tab: s.tab, label: s.label, unit: s.unit || null, kind: s.kind || 'number', env: s.env || null,
  value: get(s.name), from: sourceOf(s), def: s.def, min: s.min, max: s.max, what: s.what, ...(s.about ? s.about(get(s.name)) : {}) }));

const listeners = [];
const onChange = (fn) => listeners.push(fn);
function set(body) {
  const values = body && typeof body.values === 'object' && body.values ? body.values : {};
  const reset = Array.isArray(body && body.reset) ? body.reset : [];
  for (const [k, v] of Object.entries(values)) {
    const s = BY_NAME.get(k);
    if (!s) return [400, { ok: false, error: 'unknown_setting', message: 'There is no setting ' + String(k).slice(0, 40) + '.' }];
    if (s.check && !valid(s, v)) return [400, { ok: false, error: 'bad_value', message: s.label + ' ' + s.rule }];
    if (!valid(s, v)) return [400, { ok: false, error: 'bad_value', message: s.label + (s.kind === 'bool' ? ' is on or off.' : ' is a whole number from ' + s.min + ' to ' + s.max + '.') }];
  }
  for (const k of reset) if (!BY_NAME.has(k)) return [400, { ok: false, error: 'unknown_setting', message: 'There is no setting ' + String(k).slice(0, 40) + '.' }];
  const changed = [];
  for (const k of reset) if (Object.prototype.hasOwnProperty.call(saved, k)) { delete saved[k]; changed.push(k); }
  for (const [k, v] of Object.entries(values)) if (saved[k] !== v) { saved[k] = v; changed.push(k); }
  if (changed.length) {
    save();
    console.log('Settings changed on the page: ' + changed.map((k) => k + ' = ' + get(k)).join(', '));
    for (const fn of listeners) { try { fn(changed); } catch (e) { console.error('A settings listener failed: ' + e.message); } }
  }
  return [200, { ok: true, changed, settings: list() }];
}

async function handle(req, res, channel, rest, rctx) {
  if (rest !== '/settings') return false;
  const deny = require('./terminal').localOnly(req, rctx.port);
  if (deny) { rctx.problem(res, 403, 'local_only', deny); return true; }
  if (rctx.agent) { rctx.problem(res, 401, 'unauthorized', 'Only the person changes the settings.'); return true; }
  if (req.method === 'GET') { rctx.send(res, 200, { ok: true, file: FILE, settings: list() }); return true; }
  if (req.method !== 'POST') { rctx.problem(res, 404, 'not_found', 'Settings answers GET and POST.'); return true; }
  const [status, out] = set(await rctx.readJson(req));
  rctx.send(res, status, out);
  return true;
}

function every(name, fn, firstMs, unitMs = 1000) {
  let first = true, timer = null;
  const next = () => {
    const ms = get(name) * unitMs;
    const wait = ms > 0 ? (first && firstMs ? Math.min(ms, firstMs) : ms) : 5000;
    timer = setTimeout(() => { if (get(name) > 0) { first = false; fn(); } next(); }, wait);
    timer.unref();
  };
  onChange((names) => { if (names.includes(name)) { clearTimeout(timer); next(); } });
  next();
}

module.exports = { get, list, set, onChange, every, handle, SETTINGS, TABS, FILE };
