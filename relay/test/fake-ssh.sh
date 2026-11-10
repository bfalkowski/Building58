#!/bin/sh
# Stands in for ssh. For ssh -G, which says what host an alias in ~/.ssh/config stands for,
# FAKE_SSH_HOSTS holds alias=host pairs, split by spaces, and any other host stands for itself, as
# with no config. Run by git as GIT_SSH_COMMAND, it writes what it would ask a passphrase through to
# FAKE_SSH_LOG, and fails as if the host said no.
if [ "$1" != "-G" ]; then
  [ -n "$FAKE_SSH_LOG" ] && echo "askpass=$SSH_ASKPASS require=$SSH_ASKPASS_REQUIRE" >> "$FAKE_SSH_LOG"
  echo "fake ssh: Permission denied (publickey)." >&2
  exit 255
fi
host="$2"
for pair in $FAKE_SSH_HOSTS; do
  [ "${pair%%=*}" = "$2" ] && host="${pair#*=}"
done
echo "user git"
echo "hostname $host"
echo "port 22"
