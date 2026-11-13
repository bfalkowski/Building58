#!/usr/bin/env node
// Claude Code hook for the room. Claude Code runs it on each hook event and passes
// the event as JSON on stdin. It sends a short summary to the room through the relay as
// {"action": "hook"}. Node 18 or later, no dependencies.
//
//   node relay/office-hook.js --settings    print the hook settings to add by hand
//   node relay/office-hook.js --install     add them to ~/.claude/settings.json (keeps a backup)
//   node relay/office-hook.js --uninstall   take them out again
//   --settings or --install with --channel <name>: the channel sessions you start by hand report to
//
// It never slows Claude Code down: the settings run it in the background (async), it gives
// up on the relay after one second, and it always exits 0, even when the relay is not running.
// An event the relay did not take waits in hook-queue.jsonl in the room's state folder
// (RELAY_STATE_DIR, or ~/.office-world), and the relay applies it when it is back.
//
// Where it sends, in this order:
//   1. OFFICE_HOOK_URL with OFFICE_TICKET_TOKEN: a relay sets both on each session it starts, so
//      the session reports to that relay with its own token, whatever relay the hook's command
//      names. Two rooms on one computer each hear their own sessions this way.
//   2. Otherwise OFFICE_RELAY_URL, OFFICE_CHANNEL and the key, as below: a session you start by hand.
//
// Settings, from the environment:
//   OFFICE_RELAY_KEY      the relay key (or RELAY_KEY)
//   OFFICE_RELAY_URL      default http://localhost:8787
//   OFFICE_CHANNEL        default room. --install and --settings leave it out when it is the
//                         one the panel gave a session it started (OFFICE_PANEL_CHANNEL), so
//                         hooks installed from inside a panel session are not pinned to its page.
//   OFFICE_DETAIL         basic (default) or full. basic sends file names and the first two
//                         words of shell commands; full sends the first line of each command
//                         and search queries.
//                         Either way, a gh pr comment or gh pr review that worked also sends
//                         which PR it posted to, its kind, and the comment's link, so the
//                         relay can end an automatic reviewer once it has posted. A prompt that
//                         is a task notice, which Claude Code types when a background command
//                         ends, is marked as one, with none of its words.
//   OFFICE_SHOW_PROMPTS   1 to send the first 120 characters of each prompt. Off by default.
//   OFFICE_SHOW_TITLES    0 to not send the session's title, which is written from its prompts,
//                         nor the title you gave it with /rename, which is sent on its own too.
//   OFFICE_HOOK_LOG       a file path: also append each raw event there, to see what Claude
//                         Code sends. Raw events can hold whole prompts and file contents.
'use strict';
const STARTED = Date.now();  // when Claude Code ran this hook, as near as node can tell: before any module loads
const fs = require('fs');
const os = require('os');
const path = require('path');

const RELAY = (process.env.OFFICE_RELAY_URL || 'http://localhost:8787').replace(/\/+$/, '');
const KEY = process.env.OFFICE_RELAY_KEY || process.env.RELAY_KEY || '';
const CHANNEL = process.env.OFFICE_CHANNEL || 'office';
// The channel --install and --settings save into the hook: --channel, else OFFICE_CHANNEL unless the
// panel set it. A session the panel starts gets OFFICE_PANEL_CHANNEL with the same value (relay/terminal.js),
// and one started by an older relay only OFFICE_TERMINAL_ID. Saving that value would send every session
// from then on, from any page or terminal, to that one page's channel (T-115).
function installChannel(argv) {
  const at = argv.findIndex((a) => a === '--channel' || a.startsWith('--channel='));
  if (at >= 0) return (argv[at].startsWith('--channel=') ? argv[at].slice(10) : argv[at + 1] || '') || 'office';
  const e = process.env, mine = e.OFFICE_CHANNEL;
  if (!mine) return 'office';
  if (e.OFFICE_PANEL_CHANNEL !== undefined ? mine === e.OFFICE_PANEL_CHANNEL : !!e.OFFICE_TERMINAL_ID) return 'office';
  return mine;
}
const INSTALL_CHANNEL = installChannel(process.argv.slice(3));
// The relay that started this session, and the session's token for it (1 above).
const OWN_URL = process.env.OFFICE_HOOK_URL && process.env.OFFICE_TICKET_TOKEN ? process.env.OFFICE_HOOK_URL : '';
const FULL = process.env.OFFICE_DETAIL === 'full';
const PROMPTS = process.env.OFFICE_SHOW_PROMPTS === '1';
const TITLES = process.env.OFFICE_SHOW_TITLES !== '0';
const TITLE_TAIL = 1024 * 1024;  // Claude Code keeps rewriting the title near the end of the transcript
const LOG = process.env.OFFICE_HOOK_LOG || '';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Notification', 'Stop', 'SessionEnd'];
const MARK = 'office-hook.js';
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

// The relay requires this file to build the same hook settings for the Claude Code
// sessions it starts from the room page. Run directly, it is the hook itself.
if (require.main === module) main();
else module.exports = { hookSettings, hooksInstalled, hookCheckout, projectOf, summarize, pushedIn };

function main() {
  const arg = process.argv[2] || '';
  if (arg === '--settings') { console.log(JSON.stringify({ hooks: hookSettings() }, null, 2)); explain(); process.exit(0); }
  if (arg === '--install') { install(); process.exit(0); }
  if (arg === '--uninstall') { uninstall(); process.exit(0); }
  if (arg === '--help' || arg === '-h') { const lines = fs.readFileSync(__filename, 'utf8').split('\n'); console.log(lines.slice(1, lines.indexOf("'use strict';")).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }

  // ---------- as a hook ----------
  const hardStop = setTimeout(() => process.exit(0), 2500);
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; if (raw.length > 4e6) raw = raw.slice(0, 4e6); });
  process.stdin.on('end', () => send(raw).finally(() => { clearTimeout(hardStop); process.exit(0); }));
  process.stdin.on('error', () => process.exit(0));
}

async function send(text) {
  let p;
  try { p = JSON.parse(text); } catch (e) { return; }
  const seat = process.env.OFFICE_SEAT === '1';
  // A seat's raw events hold its private brief, so they go to no file (relay/games.js).
  if (LOG && !seat) { try { fs.appendFileSync(LOG, JSON.stringify(p) + '\n'); } catch (e) { /* ignore */ } }
  if (!p || !p.hook_event_name) return;
  // at: when Claude Code ran the hook, so the relay can tell an old event from a new one.
  let event = Object.assign(summarize(p), { at: STARTED });
  // A seat in a round of a game sends its events, but none of its words, sent or queued: its first
  // prompt is its private brief (relay/games.js).
  if (seat) event = require('./round-seats.js').quiet(event);
  const body = JSON.stringify({ action: 'hook', event, source: 'claude-code', wait: false });
  const to = OWN_URL || RELAY + '/channels/' + encodeURIComponent(CHANNEL) + '/commands';
  let r = null;
  try {
    // The token goes only to its own relay, and the key only to the relay the command names.
    const auth = OWN_URL ? { 'X-Office-Token': process.env.OFFICE_TICKET_TOKEN } : { Authorization: 'Bearer ' + KEY };
    r = await fetch(to, { method: 'POST', body, signal: AbortSignal.timeout(1000), headers: Object.assign({ 'Content-Type': 'application/json' }, auth) });
  } catch (e) { /* the relay is not running, or did not answer in time */ }
  // No answer: the event waits in the room's state folder, and the relay applies it when it is back
  // (relay/hook-queue.js). Any answer at all means the relay heard it.
  if (!r) {
    const queue = require('./hook-queue.js'), state = require('./state.js');
    queue.append(state.dir(), { to, auth: queue.hash(OWN_URL ? process.env.OFFICE_TICKET_TOKEN : KEY), event });
  }
}

const cut = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
// A checkout of the room's own (relay/tasks.js, relay/checkouts.js) is on the repo's project.
function projectOf(cwd) {
  const m = String(cwd).match(/^(.*)[\\/]\.worktrees[\\/][^\\/]+(?:[\\/]|$)/);
  return path.basename(m ? m[1] : cwd);
}
function summarize(p) {
  const out = { hook_event_name: p.hook_event_name, session_id: cut(p.session_id, 12) };
  if (p.cwd) out.project = cut(projectOf(p.cwd), 40);
  for (const k of ['agent_id', 'agent_type', 'tool_name', 'notification_type', 'source', 'reason']) if (p[k]) out[k] = cut(p[k], 80);
  if (p.message) out.message = cut(p.message, 120);
  if (process.env.OFFICE_TERMINAL_ID) {  // set by the room's panel
    out.terminal = cut(process.env.OFFICE_TERMINAL_ID, 40);
    if (p.hook_event_name === 'SessionStart') out.full_session_id = cut(p.session_id, 36);  // /clear gives a new id, and resuming needs all of it
  }
  if (PROMPTS && p.prompt) out.prompt = cut(p.prompt, 120);
  // Claude Code types a <task-notification> as a prompt when the session's own background command ends.
  // The relay must not take it for the person, so it says which it is, and sends none of its words.
  if (p.hook_event_name === 'UserPromptSubmit' && typeof p.prompt === 'string' && p.prompt.startsWith('<task-notification>')) out.notice = true;
  if (TITLES && p.transcript_path && p.hook_event_name !== 'SessionEnd' && p.hook_event_name !== 'PostToolUse') {
    const { title, custom } = sessionTitle(p.transcript_path);
    if (title) out.title = cut(title, 60);
    if (custom !== null) out.customTitle = cut(custom, 60);  // '' when the newest /rename record has none
  }
  if (p.tool_input && typeof p.tool_input === 'object') out.tool_input = toolInput(p.tool_name || '', p.tool_input, p.cwd);
  // A huddle question asks for one line starting with its marker. Only that line leaves the hook, and
  // none of the session's other words do.
  if (p.hook_event_name === 'Stop' && typeof p.last_assistant_message === 'string') {
    const answer = p.last_assistant_message.match(/HUDDLE-([0-9a-f]{6}):[ \t]*(.+)/);
    if (answer) { out.huddle_id = answer[1]; out.huddle_answer = cut(answer[2], 300); }
  }
  if (p.hook_event_name === 'PostToolUse') {
    delete out.tool_input;  // the room only needs to know the tool finished, or that it opened a PR
    const ran = p.tool_name === 'Bash' && p.tool_input && String(p.tool_input.command || '');
    if (ran && /\bgh\s+pr\s+create\b/.test(ran)) {
      const pr = JSON.stringify(p.tool_response || '').match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/);
      if (pr) { out.pr_url = pr[0]; if (p.cwd) out.cwd = p.cwd; }
    }
    const posted = ran && postedTo(ran, p.tool_response);
    if (posted) out.posted = posted;
    if (ran && pushedIn(ran, p.tool_response)) out.pushed = true;
  }
  return out;
}
// A review posted with gh pr comment or gh pr review: { pr, repo, kind, url }, or null. It reads the
// gh command's own words, and sends none of them. Heredoc bodies and quoted text are blanked first,
// so a gh command quoted in a review's body is not taken for one that ran. Lines joined with a
// backslash are read as one. When one command posts more than once, the last post counts.
// PostToolUse means the whole command worked. gh pr comment prints the comment's link when it posts,
// so that also needs the link in the output, which catches a failure hidden with `|| true`. gh pr review
// prints nothing when it is not in a terminal, so PostToolUse is all there is. That is gh's own answer
// only when nothing runs after it but more commands joined with &&, or the `; fi` or `; }` that closes
// its block: after `|`, `;`, `||`, `&` or another line, its failure would be hidden, so the review does
// not count. repo is null for a bare number, which gh takes from the folder.
const VALUE_FLAGS = new Set(['-b', '--body', '-F', '--body-file', '-R', '--repo']);
const NOT_POSTED = new Set(['-w', '--web', '--delete-last', '--edit-last', '-e', '--editor', '-h', '--help']);
const GH_POST = /(?:^|[\n;&|(`])[ \t]*(?:(?:then|do|else)[ \t]+)?(?:\w+=\S*[ \t]+)*gh\s+pr\s+(comment|review)\b/g;
const REDIRECT = /\d*[<>]&\d*-?|&>>?/g;  // 2>&1 and &>file move output, they do not start a command
const blank = (text) => ' '.repeat(text.length);
function blankText(cmd) {
  return cmd
    .replace(/(<<-?[ \t]*(['"]?)(\w+)\2[^\n]*\n)([\s\S]*?\n[ \t]*\3)(?=\n|$)/g, (all, head, q, tag, body) => head + blank(body))
    .replace(/'[^']*'|"(?:\\[\s\S]|[^"\\])*"/g, (q) => q[0] + blank(q.slice(1, -1)) + q.slice(-1))
    .replace(/\\\n/g, '  ')
    .replace(REDIRECT, blank);
}
function postedTo(cmd, response) {
  // Only gh at the start of a command, not a word of echo or grep.
  const text = blankText(String(cmd));
  let last = null;
  for (const m of text.matchAll(GH_POST)) {
    const from = m.index + m[0].length, eol = text.indexOf('\n', from) < 0 ? text.length : text.indexOf('\n', from);
    last = postedBy(m[1], text.slice(from, eol), response, text.slice(eol)) || last;
  }
  return last;
}
// Whether what runs after gh can hide its exit code. `&&` cannot, and nor can the `; fi` or `; }`
// that closes the block gh is the last command of.
function exitHidden(after) {
  return /[;|&\n]/.test(after.replace(/&&/g, ' ').replace(/[;\n]\s*(?:fi|\})(?=[\s;)`]|$)/g, ' ').trimEnd());
}
function postedBy(verb, rest, response, tail) {
  const words = rest.match(/'[^']*'|"[^"]*"|&&|\|\||[;|&]|[^\s;|&'"]+/g) || [];
  let selector = null, repo = null, kind = verb === 'comment' ? 'comment' : 'review';
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i];
    if (/^(&&|\|\||[;|&])$/.test(w)) break;  // the next command
    const flag = w.split('=')[0];
    if (NOT_POSTED.has(flag)) return null;
    if (flag === '-R' || flag === '--repo') { repo = w.includes('=') ? w.slice(w.indexOf('=') + 1) : words[++i] || ''; continue; }
    if (VALUE_FLAGS.has(flag)) { if (!w.includes('=')) i++; continue; }
    if (verb === 'review' && /^(-a|--approve)$/.test(w)) kind = 'approve';
    else if (verb === 'review' && /^(-r|--request-changes)$/.test(w)) kind = 'request-changes';
    else if (!w.startsWith('-') && selector === null) selector = w;
  }
  const link = (x) => x && x.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/#?].*)?$/);
  const at = link(selector);
  let pr = at ? Number(at[2]) : /^#?\d+$/.test(selector || '') ? Number(selector.replace('#', '')) : null;
  if (at) repo = at[1];
  if (repo !== null && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  if (verb === 'review' && exitHidden(words.slice(i).join(' ') + tail)) return null;
  let url = null;
  if (kind === 'comment') {
    const said = JSON.stringify(response || '').match(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)#issuecomment-\d+/);
    if (!said || (pr !== null && Number(said[2]) !== pr) || (repo && said[1].toLowerCase() !== repo.toLowerCase())) return null;
    pr = Number(said[2]); repo = said[1]; url = said[0];
  }
  if (pr === null) return null;
  // Claude Code may say which PR a gh command reached. Not a documented format, so only used to fill in the repo.
  const reached = response && response.gitOperation && response.gitOperation.pr, at2 = reached && link(String(reached.url || ''));
  if (!repo && at2 && Number(at2[2]) === pr) repo = at2[1];
  return { pr, repo, kind, url };
}
// Whether a shell command that worked may have pushed commits, so the room can review the PR
// again. "Everything up-to-date" with no ref line of a moved branch (MOVED) means nothing went up, so
// that is checked first, even when Claude Code saw a push. Such a line means some push in the command
// sent commits, so up-to-date output from another push does not hide it. Otherwise Claude Code says so
// itself in gitOperation.push when git printed what it sent. A quiet push (-q) prints nothing and
// gets no gitOperation, and a pipe or `;` after it hides whether it worked, so then any git push at
// the start of a command counts, also one inside an if, a loop or { }: the relay starts the
// follow-up review only if the PR's head moved since its last review (relay/checkouts.js). Only git
// at the start of a command counts, as postedTo reads gh, not the words of a commit message or a
// heredoc. A push that cannot move a branch does not count: --dry-run, --delete, a refspec
// ":branch" (it deletes, while a bare ":" pushes the matching branches), --tags with no branch
// named, and --mirror, which is not how a Dev updates a PR.
const GIT_PUSH = /(?:^|[\n;&|(`{])[ \t]*(?:(?:then|do|else|if|while|until|!)[ \t]+)*(?:\w+=\S*[ \t]+)*(?:(?:env|command|time)[ \t]+(?:\w+=\S*[ \t]+)*)?git(?:[ \t]+-[Cc][ \t]+\S+)*[ \t]+push(?=[ \t]|$|[\n;&|)`}])([^\n;&|)`}]*)/g;
// A ref line of a branch that moved: `1234567..89abcde  HEAD -> task/a`, forced with `...`, a new
// branch or ref. With --porcelain git writes `<flag>\t<from>:<to>\t<summary>` instead, and the JSON of
// the output holds that tab as the two characters \t. Not `= [up to date]`, a new tag, or some other
// arrow in the output.
const SENT = '(?:[0-9a-f]{7,}\\.\\.\\.?[0-9a-f]{7,}|\\[new (?:branch|reference)\\])';
const MOVED = new RegExp(SENT + ' +\\S+ -> |\\\\t\\S+:\\S+\\\\t' + SENT);
function pushedIn(cmd, response) {
  const said = JSON.stringify(response || '');
  if (/Everything up-to-date/.test(said) && !MOVED.test(said)) return false;
  const r = response && typeof response === 'object' ? response : {};
  if (r.gitOperation && r.gitOperation.push) return true;
  for (const m of blankText(String(cmd)).matchAll(GIT_PUSH)) if (movesBranch(m[1])) return true;
  return false;
}
// The words after git push: [options] [remote [refspec...]].
const PUSH_VALUE_FLAGS = new Set(['--repo', '--receive-pack', '--exec', '-o', '--push-option']);
function movesBranch(args) {
  const words = args.trim().split(/[ \t]+/).filter(Boolean), plain = [];
  let tags = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^(?:--dry-run|-n|--delete|-d|--mirror)$/.test(w)) return false;
    if (w === '--tags') { tags = true; continue; }
    if (PUSH_VALUE_FLAGS.has(w) || /^\d*[<>]+$/.test(w)) { i++; continue; }  // > file: the file is not a refspec
    if (w.startsWith('-') || /^\d*[<>]/.test(w)) continue;
    plain.push(w);
  }
  const refspecs = plain.slice(1).map((x) => x.replace(/^\+/, ''));
  if (refspecs.length && refspecs.every((x) => /^:./.test(x))) return false;  // ":" alone pushes the matching branches
  if (tags && !refspecs.length) return false;
  return true;
}
// The session's title from its transcript: the one you gave it with /rename, or else the one
// Claude Code wrote. custom is the newest /rename record's title alone, or null when there is none.
// These records are not a public format, so anything unexpected means no title.
function sessionTitle(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, tail = Math.min(size, TITLE_TAIL);
    const buf = Buffer.alloc(tail);
    const lines = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, tail, size - tail)).split('\n');
    let ai = '', title = '', custom = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].length > 2000 || !lines[i].includes('-title"')) continue;
      let r;
      try { r = JSON.parse(lines[i]); } catch (e) { continue; }
      if (r.type === 'custom-title' && custom === null) custom = typeof r.customTitle === 'string' ? r.customTitle : '';
      if (r.type === 'custom-title' && r.customTitle) { title = r.customTitle; break; }
      if (r.type === 'ai-title' && r.aiTitle && !ai) ai = r.aiTitle;
    }
    return { title: title || ai, custom };
  } catch (e) { return { title: '', custom: null }; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function toolInput(tool, ti, cwd) {
  const o = {};
  if (tool === 'Skill') { o.skill = cut(ti.skill || ti.command || ti.name, 80); if (FULL && ti.args) o.args = cut(ti.args, 60); }
  if (ti.subagent_type) o.subagent_type = cut(ti.subagent_type, 60);
  if (ti.description) o.description = cut(ti.description, 60);
  const f = ti.file_path || ti.notebook_path || ti.path;
  if (typeof f === 'string' && f) o.file = shortPath(f, cwd);
  if (ti.pattern) o.pattern = cut(ti.pattern, 40);
  if (tool === 'Bash' && ti.command) o.command = FULL ? cut(String(ti.command).split('\n')[0], 80) : firstWords(ti.command);
  if (ti.url) { try { o.host = new URL(ti.url).host; } catch (e) { /* not a URL */ } }
  if (FULL && ti.query) o.query = cut(ti.query, 50);
  return o;
}
function shortPath(f, cwd) {
  let rel = cwd && path.isAbsolute(f) ? path.relative(cwd, f) : f;
  if (rel.startsWith('..')) rel = path.basename(f);
  return rel.length > 48 ? '…' + rel.slice(-47) : rel;
}
// "cd app && npm test -- --watch" -> "npm test": the first two words of the first command
// that is not cd, without arguments that could hold paths, URLs or secrets
function firstWords(cmd) {
  const parts = String(cmd).split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
  const main = parts.find((s) => !/^cd\b/.test(s)) || parts[0] || '';
  const words = main.replace(/^(\w+=\S+\s+)+/, '').split(/\s+/).filter((w) => /^[\w@.:/+-]+$/.test(w) && !/[=/]/.test(w.slice(1)));
  return words.slice(0, 2).join(' ').slice(0, 40);
}

// ---------- settings ----------
function command(o) {
  o = o || {};
  const key = o.key || KEY || 'pick-a-key', url = o.url || RELAY, channel = o.channel || INSTALL_CHANNEL;
  const env = 'OFFICE_RELAY_KEY=' + shellQuote(key) + (url !== 'http://localhost:8787' ? ' OFFICE_RELAY_URL=' + shellQuote(url) : '') + (channel !== 'office' ? ' OFFICE_CHANNEL=' + shellQuote(channel) : '');
  return env + (TITLES ? '' : ' OFFICE_SHOW_TITLES=0') + ' node ' + shellQuote(path.resolve(__filename));
}
function shellQuote(s) { return /^[\w@%+=:,./-]+$/.test(s) ? s : "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function hookSettings(o) {
  const hooks = {};
  for (const e of EVENTS) {
    const h = { type: 'command', command: command(o) };
    if (e === 'SessionEnd') h.timeout = 5; else h.async = true;  // SessionEnd runs as the session closes, so it stays in the foreground
    hooks[e] = [e === 'PreToolUse' || e === 'PostToolUse' || e === 'PostToolUseFailure' ? { matcher: '*', hooks: [h] } : { hooks: [h] }];
  }
  return hooks;
}
function explain() {
  console.error('\nAdd these "hooks" to ~/.claude/settings.json (all projects) or to .claude/settings.json');
  console.error('in one project. If the file already has hooks for an event, add these entries to its list.');
  console.error('Or run: node relay/office-hook.js --install');
  if (!KEY) console.error('\nThe key is a placeholder. Run it as: OFFICE_RELAY_KEY=<your relay key> node relay/office-hook.js --settings');
  console.error('Sessions you start by hand report to channel ' + INSTALL_CHANNEL + '. Add --channel <name> for another.');
}
// true when ~/.claude/settings.json already runs this hook for every session
function hooksInstalled() {
  try { return fs.readFileSync(SETTINGS, 'utf8').includes(MARK); } catch (e) { return false; }
}
// Which office-hook.js the hooks in ~/.claude/settings.json run, against this file. Hooks from
// another checkout run that checkout's code, so new hook fields never arrive. Only paths come back,
// never the command, which holds the key.
function hookCheckout() {
  const own = real(__filename), out = { installed: false, match: true, own, from: [] };
  let s;
  try { s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) { return out; }
  const found = new Set();
  for (const list of Object.values((s && s.hooks) || {})) {
    for (const m of Array.isArray(list) ? list : []) {
      for (const h of (m && Array.isArray(m.hooks)) ? m.hooks : []) {
        const c = String((h && h.command) || '');
        if (!c.includes(MARK)) continue;
        const q = c.match(/'([^']*office-hook\.js)'/) || c.match(/"([^"]*office-hook\.js)"/) || c.match(/(\S*office-hook\.js)/);
        // A relative path, written by hand, depends on the folder each session runs in, so the
        // relay cannot tell which file it is. --install and --settings always write absolute paths.
        if (q && path.isAbsolute(q[1])) found.add(real(q[1]));
      }
    }
  }
  out.installed = found.size > 0;
  out.from = [...found].filter((f) => f !== own);
  out.match = !out.from.length;
  return out;
}
function real(f) { try { return fs.realpathSync(f); } catch (e) { return path.resolve(f); } }
function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) {
    console.error(SETTINGS + ' is not valid JSON, so it was not changed: ' + e.message); process.exit(1);
  }
}
function writeSettings(s, verb) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, SETTINGS + '.before-office');
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');
  console.log(verb + ' ' + SETTINGS + (fs.existsSync(SETTINGS + '.before-office') ? ' (the old file is ' + path.basename(SETTINGS) + '.before-office)' : ''));
}
function strip(s) {
  let removed = 0;
  for (const e of Object.keys(s.hooks || {})) {
    const list = Array.isArray(s.hooks[e]) ? s.hooks[e] : [];
    s.hooks[e] = list.map((m) => Object.assign({}, m, { hooks: (m.hooks || []).filter((h) => { const ours = String(h.command || '').includes(MARK); if (ours) removed++; return !ours; }) }))
      .filter((m) => m.hooks.length);
    if (!s.hooks[e].length) delete s.hooks[e];
  }
  if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
  return removed;
}
function install() {
  if (!KEY) { console.error('Set the relay key first: OFFICE_RELAY_KEY=<your relay key> node relay/office-hook.js --install'); process.exit(1); }
  const s = readSettings();
  strip(s);
  s.hooks = s.hooks || {};
  const ours = hookSettings();
  for (const e of EVENTS) s.hooks[e] = (s.hooks[e] || []).concat(ours[e]);
  writeSettings(s, 'Added the room hooks to');
  console.log('New Claude Code sessions send their events to ' + RELAY + ', channel ' + INSTALL_CHANNEL + '.');
  console.log('To pick another channel, run it again with --channel <name>' + (process.env.npm_lifecycle_event ? ' (npm run office:hooks -- --channel <name>)' : '') + '.');
}
function uninstall() {
  const s = readSettings();
  const n = strip(s);
  if (!n) { console.log('No room hooks found in ' + SETTINGS + '.'); return; }
  writeSettings(s, 'Took ' + n + ' room hooks out of');
}
