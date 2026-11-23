#!/bin/bash
# Stands in for macOS's caffeinate: writes its pid and its arguments to a file in the relay's home, then
# stays until the process named after -w ends, as the real one does (relay/keep-awake.js).
trap 'rm -f "$HOME/.keep-awake"; exit 0' TERM
echo "$$ $*" > "$HOME/.keep-awake"
while [ "$1" != "-w" ] && [ $# -gt 0 ]; do shift; done
while kill -0 "$2" 2>/dev/null; do sleep 0.1; done
rm -f "$HOME/.keep-awake"
