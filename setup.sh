#!/bin/sh
# Sets up a Building58 room in Docker and starts it: ./setup.sh
# It fills in .env, asking only for what it cannot make itself, then runs docker compose up -d, waits
# until the room is healthy, says what the room found, and opens the room page. Each step that is
# already done is skipped, so it is safe to run again. See docs/manual/running.html#container-setup-sh.
#   1. .env from .env.example, readable only by you, with a random RELAY_KEY.
#   2. Claude Code: a token from `claude setup-token`, or a Claude Console API key, pasted once.
#   3. GitHub: the room's own GitHub App (relay/github-app.js create), then a link to install it. With no
#      Node on this computer, the helper runs inside the room's image.
#   4. ROOM_REPOS: the repos the room works on, as owner/name.
set -eu
cd "$(dirname "$0")"
ENV=.env

say() { printf '%s\n' "$*"; }
stop() { printf '%s\n' "$*" >&2; exit 1; }
get() { [ -f "$ENV" ] && sed -n "s/^$1=//p" "$ENV" | tail -1 || true; }
put() {
  tmp="$ENV.tmp.$$"
  if grep -q "^$1=" "$ENV" 2>/dev/null; then
    awk -v k="$1" -v v="$2" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$ENV" > "$tmp"
  else
    cp "$ENV" "$tmp"; printf '%s=%s\n' "$1" "$2" >> "$tmp"
  fi
  chmod 600 "$tmp"; mv "$tmp" "$ENV"
}
ask() { [ -t 0 ] || stop "$1 is not set in $ENV, and there is no terminal to ask in."; printf '%s ' "$2" >&2; read -r answer; printf '%s' "$answer"; }
secret() { [ -t 0 ] || stop "$1 is not set in $ENV, and there is no terminal to ask in."; printf '%s ' "$2" >&2; stty -echo; read -r answer; stty echo; printf '\n' >&2; printf '%s' "$answer"; }
open_link() { if command -v open >/dev/null 2>&1; then open "$1"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 || true; fi; }

command -v docker >/dev/null 2>&1 || stop "Install Docker first: Docker Desktop, Colima, or Docker Engine on Linux."
docker info >/dev/null 2>&1 || stop "Docker is installed but not running. Start it (for example: colima start), then run ./setup.sh again."
docker compose version >/dev/null 2>&1 || stop "This needs Docker Compose (docker compose)."

if [ ! -f "$ENV" ]; then
  (umask 077; cp .env.example "$ENV")
  say "Made $ENV from .env.example. Never commit it: git ignores it."
fi
chmod 600 "$ENV"

if [ -z "$(get RELAY_KEY)" ]; then
  put RELAY_KEY "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  say "Picked a room key (RELAY_KEY)."
fi

if [ -z "$(get CLAUDE_CODE_OAUTH_TOKEN)$(get ANTHROPIC_API_KEY)$(get CLAUDE_CODE_USE_BEDROCK)$(get CLAUDE_CODE_USE_VERTEX)" ]; then
  say ""
  say "Claude Code needs a sign-in. Either:"
  say "  - a token for your Claude subscription: run 'claude setup-token' in another terminal, or"
  say "  - a Claude Console API key."
  token=$(secret CLAUDE_CODE_OAUTH_TOKEN "Paste it here (it will not show):")
  case "$token" in
    sk-ant-oat*) put CLAUDE_CODE_OAUTH_TOKEN "$token"; say "Saved as CLAUDE_CODE_OAUTH_TOKEN." ;;
    sk-ant-api*) put ANTHROPIC_API_KEY "$token"; say "Saved as ANTHROPIC_API_KEY." ;;
    "") stop "No sign-in given. Run ./setup.sh again when you have one." ;;
    *) stop "That does not look like a Claude token (sk-ant-oat...) or API key (sk-ant-api...). Nothing was saved." ;;
  esac
fi

if [ -z "$(get GITHUB_APP_ID)$(get GH_TOKEN)" ]; then
  say ""
  say "The room acts on GitHub as an app of its own, which reaches only the repos you install it on."
  say "Your browser will open GitHub with the app's settings filled in. Press Create GitHub App there."
  ask GITHUB_APP_ID "Press Enter to start." >/dev/null
  if command -v node >/dev/null 2>&1; then
    node relay/github-app.js create --env "$ENV"
    install=""
  else
    image="ghcr.io/bfalkowski/building58:$(get BUILDING58_VERSION)"; [ "$image" = "ghcr.io/bfalkowski/building58:" ] && image="ghcr.io/bfalkowski/building58:latest"
    out=$(mktemp)
    docker run --rm -p 127.0.0.1:47123:47123 --entrypoint node "$image" /opt/building58/relay/github-app.js create --print --host 0.0.0.0 --port 47123 > "$out" 2>&1 &
    helper=$!
    for i in $(seq 120); do grep -q '^Opening' "$out" && break; sleep 1; done
    open_link "http://localhost:47123/"
    say "If no browser opened, open http://localhost:47123/"
    wait "$helper" || { cat "$out" >&2; rm -f "$out"; stop "The GitHub App was not made."; }
    put GITHUB_APP_ID "$(sed -n 's/^GITHUB_APP_ID=//p' "$out")"
    put GITHUB_APP_PRIVATE_KEY "$(sed -n 's/^GITHUB_APP_PRIVATE_KEY=//p' "$out")"
    install=$(sed -n 's/^GITHUB_APP_INSTALL=//p' "$out")
    rm -f "$out"
    say "Saved the app's id and key in $ENV."
  fi
  [ -z "$(get GITHUB_APP_ID)" ] && stop "The GitHub App was not saved in $ENV. Run ./setup.sh again."
  [ -n "$install" ] && { open_link "$install"; say "Install it on the repos the room works on: $install"; }
  ask GITHUB_APP_ID "Press Enter when the app is installed." >/dev/null
fi

if [ -z "$(get ROOM_REPOS)" ]; then
  say ""
  repos=$(ask ROOM_REPOS "Which repos should the room work on? owner/name, with spaces between:")
  [ -n "$repos" ] && put ROOM_REPOS "$repos" || say "No repos for now. Add them to ROOM_REPOS in $ENV later."
fi

say ""
say "Starting the room..."
docker compose up -d
port=$(get ROOM_PORT); port=${port:-8787}
for i in $(seq 180); do curl -fs -o /dev/null "http://127.0.0.1:$port/health" 2>/dev/null && break; sleep 2; done
curl -fs -o /dev/null "http://127.0.0.1:$port/health" || stop "The room did not answer on port $port. See: docker compose logs room"
for i in $(seq 60); do docker compose logs --no-log-prefix room 2>/dev/null | grep -q '^Repos:' && break; sleep 2; done
say ""
docker compose logs --no-log-prefix room 2>/dev/null | grep -E '^(Claude Code|GitHub|Repos):' || true
link="http://localhost:$port/office/?channel=office&key=$(get RELAY_KEY)"
say ""
say "The room is running. Open it: http://localhost:$port/office/?channel=office&key=<RELAY_KEY in $ENV>"
open_link "$link"
