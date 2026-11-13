#!/bin/bash
# Stands in for `claude`: says it started, draws a prompt, and echoes each line typed into it.
# With FAKE_CLAUDE_FAIL_RESUME set, --resume fails at once, as a real one with no transcript would.
if [ -n "$FAKE_CLAUDE_FAIL_RESUME" ] && [ "$1" = "--resume" ]; then echo "No conversation found with session ID: $2"; exit 1; fi
# Its id ($2 after --session-id or --resume), pid and ticket token go to a file in the relay's home, so a
# test finds the token without looking at other processes (sessionTokens in relay/test/helpers.js).
echo "$2 $$ $OFFICE_TICKET_TOKEN" >> "$HOME/.fake-claude-tokens"
echo "fake claude $*"
echo "child session: ${CLAUDE_CODE_CHILD_SESSION:-none}"
echo "office channel: ${OFFICE_CHANNEL:-none}"
echo "office panel channel: ${OFFICE_PANEL_CHANNEL:-none}"
echo "office hook url: ${OFFICE_HOOK_URL:-none}"
echo "office play: ${OFFICE_PLAY:-none}"
# With FAKE_CLAUDE_TRUST set, it asks whether to trust the folder, as a real one does in a new folder.
if [ -n "$FAKE_CLAUDE_TRUST" ]; then echo "Do you trust the files in this folder?"; fi
printf '\xe2\x9d\xaf \n'
# With FAKE_CLAUDE_SLOW_EXIT set, it takes a second to end once the relay hangs it up, so a test can see
# a session that is stopped but still ending.
if [ -n "$FAKE_CLAUDE_SLOW_EXIT" ]; then trap 'sleep 1; exit 0' HUP; fi
# /job starts a background job as the Bash tool does: a shell run with -c that sources Claude Code's shell
# snapshot, here around a sleep of 60 seconds (relay/jobs.js). /nojob ends it. /helper starts a child that
# is not a job, as Claude Code's caffeinate is.
job=''
# It reads keys raw, so the terminal's own 1024-byte line limit cuts nothing: only the rule below does.
# Ctrl+U still clears what was typed so far, as the relay expects when it takes text back out.
stty -icanon min 1 time 0 2>/dev/null
# A paste comes in marked (ESC[200~ ... ESC[201~). Like a real one, it drops the marks and keeps the
# text, and it says PASTED before the line so a test can tell a paste from typed keys.
# /exit quits with 0, as a real one does.
# /spin draws a spinner line every 200 ms from then on, as a real one does while it thinks, and sends no
# hook, so a test can see a session whose output moves while its hooks are silent. /still stops it, and so
# does the end of this script.
# With FAKE_CLAUDE_DROP_ENTER=first, it ignores the first Enter after a paste, as a real one can while it
# still takes the paste in: the text stays in its box, drawn again, and the next Enter sends it. With
# FAKE_CLAUDE_DROP_ENTER=all, it ignores every Enter after a paste, so the text is never sent.
spin=''; held=''; dropped=''
while IFS= read -r line; do
  line="$held$line"; held=''
  line="${line##*$'\x15'}"; how=''
  case "$line" in *$'\e[200~'*) how='PASTED '; line="${line//$'\e[200~'/}"; line="${line//$'\e[201~'/}";; esac
  # Keys that are not a paste come in about 1024 bytes at a time, and a real one keeps only the last
  # piece (T-34), so this one does too.
  if [ -z "$how" ]; then
    bytes=$(printf %s "$line" | wc -c | tr -d ' ')
    if [ "$bytes" -gt 1024 ]; then last=$((bytes % 1024)); [ "$last" -eq 0 ] && last=1024; line=$(printf %s "$line" | tail -c "$last"); fi
  fi
  if [ -n "$how" ] && { [ "$FAKE_CLAUDE_DROP_ENTER" = "all" ] || { [ "$FAKE_CLAUDE_DROP_ENTER" = "first" ] && [ -z "$dropped" ]; }; }; then
    dropped=1; held=$'\e[200~'"$line"$'\e[201~'
    printf '\xe2\x9d\xaf %s\n' "$line"; continue
  fi
  echo "${how}GOT[$line]"; [ "$line" = "/exit" ] && exit 0
  if [ "$line" = "/still" ] && [ -n "$spin" ]; then kill "$spin" 2>/dev/null; spin=''; fi
  if [ "$line" = "/job" ] && [ -z "$job" ]; then
    bash -c 'source "$HOME/.claude/shell-snapshots/snapshot-bash-fake.sh" 2>/dev/null || true; sleep 60; :' &
    job=$!
  fi
  if [ "$line" = "/nojob" ] && [ -n "$job" ]; then pkill -P "$job" 2>/dev/null; kill "$job" 2>/dev/null; job=''; fi
  if [ "$line" = "/helper" ]; then sleep 60 & fi
  # /env prints its environment, so a test can see what a session was given.
  if [ "$line" = "/env" ]; then env | sort; echo ENV-END; fi
  # /readall <path>... tries to read each path, as a seat with a shell could, and says what it got.
  case "$line" in /readall\ *) for f in ${line#/readall }; do if c=$(head -c 40 "$f" 2>/dev/null); then echo "READ $f: ok $c"; else echo "READ $f: refused"; fi; done;; esac
  if [ "$line" = "/spin" ] && [ -z "$spin" ]; then
    ( i=0; while kill -0 $$ 2>/dev/null; do printf '\r\xe2\x9c\xbb Thinking\xe2\x80\xa6 (%ss)' $((i / 5)); i=$((i + 1)); sleep 0.2; done ) &
    spin=$!
  fi
done
