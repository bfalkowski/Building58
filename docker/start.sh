#!/bin/sh
# Starts a room in the container (Dockerfile). On the first start it copies the image's Building58
# folder, with its git history, into the Building58 volume, so the relay can update itself there.
# Later starts run whatever that volume holds, so a new image does not undo an Update.
set -eu

APP=/home/node/building58
SEED=/opt/building58

if [ ! -e "$APP/.git" ]; then
  if [ ! -d "$SEED/.git" ]; then
    echo "The image has no git history in $SEED. Build it from a clone of the repo, not from a git worktree." >&2
    exit 1
  fi
  cp -a "$SEED/." "$APP/"
  git -C "$APP" remote set-url origin "${BUILDING58_REPO:-https://github.com/bfalkowski/Building58.git}"
  # An image built from a release tag holds no branch, and Update works only on main. A release is a
  # commit of main, so start main there, following origin's main.
  if ! git -C "$APP" symbolic-ref -q HEAD >/dev/null; then git -C "$APP" checkout -q -B main; fi
  git -C "$APP" config branch.main.remote origin
  git -C "$APP" config branch.main.merge refs/heads/main
  echo "Copied Building58 into $APP."
fi

if [ -z "${RELAY_KEY:-}" ]; then
  echo "Set RELAY_KEY in .env. The room page needs it." >&2
  exit 1
fi

cd "$APP"
# With a GitHub App, gh reads the App's token from its hosts.yml, which is renewed. A GH_TOKEN would win over it.
if [ -n "${GITHUB_APP_ID:-}" ]; then unset GH_TOKEN GITHUB_TOKEN; fi
node relay/container-setup.js
# The room's own sessions report with their own token, so the hooks need no key. Every session can
# read ~/.claude/settings.json, so the real key stays out of it, and the hooks get a placeholder.
env -u RELAY_KEY OFFICE_RELAY_KEY=sessions-use-their-token node relay/office-hook.js --install >/dev/null
exec node relay/container-forward.js
