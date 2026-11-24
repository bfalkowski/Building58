#!/bin/bash
# Stands in for macOS's caffeinate. It writes "start <pid> <args>" to $FAKE_CAFFEINATE_LOG, and "end <pid>"
# when it ends. Like `caffeinate -w <pid>`, it ends when that process does.
log="${FAKE_CAFFEINATE_LOG:-/dev/null}"
echo "start $$ $*" >> "$log"
trap 'echo "end $$" >> "$log"; exit 0' TERM INT HUP
watched=''
while [ $# -gt 0 ]; do [ "$1" = "-w" ] && watched="$2"; shift; done
while [ -n "$watched" ] && kill -0 "$watched" 2>/dev/null; do sleep 0.1; done
echo "end $$" >> "$log"
