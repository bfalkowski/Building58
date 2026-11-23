#!/bin/sh
# Sets up a Building58 room in Docker and starts it: ./setup.sh
# It fills in .env, asking only for what it cannot make itself, then runs docker compose up -d, waits
# until the room is healthy, says what the room found, and opens the room page. Each step that is
# already done is skipped, so it is safe to run again. See docs/manual/running.html#container-setup-sh.
#   1. .env from .env.example, readable only by you, with a random RELAY_KEY.
#   2. Claude Code: a token from `claude setup-token`, or a Claude Console API key, pasted once.
#   3. GitHub: the room's own GitHub App (relay/github-app.js create), then a link to install it. With no
#      Node 18 or later on this computer, the helper runs in a container from the room's image, with this
#      clone's relay/github-app.js copied in, so any image version works. It listens on 127.0.0.1 at
#      SETUP_APP_PORT, 47123 unless you set it.
#      With no display (no DISPLAY or WAYLAND_DISPLAY on Linux), each link is printed, not opened, and
#      before the GitHub step it prints the ssh -L command to run on your laptop, and waits.
#      SETUP_HEADLESS=1 or 0 overrides the guess.
#   4. ROOM_REPOS: the repos the room works on, as owner/name.
set -eu
cd "$(dirname "$0")"
ENV=.env
HELPER=building58-setup-app
APP_PORT=${SETUP_APP_PORT:-47123}
cleanup() { stty echo 2>/dev/null || true; docker rm -f "$HELPER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM
trap 'cleanup; exit 129' HUP

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
secret() { [ -t 0 ] || stop "$1 is not set in $ENV, and there is no terminal to ask in."; printf '%s ' "$2" >&2; stty -echo; read -r answer || true; stty echo; printf '\n' >&2; printf '%s' "$answer"; }
headless() { case "${SETUP_HEADLESS:-}" in 1) return 0 ;; 0) return 1 ;; esac; [ "$(uname)" != Darwin ] && [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; }
open_link() {
  if headless; then say "Open this link in your browser: $1"
  elif command -v open >/dev/null 2>&1; then open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 || true
  else say "Open this link in your browser: $1"; fi
}
hostname_() { hostname 2>/dev/null || uname -n; }
tunnel() { printf 'ssh -N -L %s:localhost:%s %s@%s' "$1" "$1" "$(id -un)" "$(hostname_)"; }

command -v docker >/dev/null 2>&1 || stop "Install Docker first: Docker Desktop, Colima, or Docker Engine on Linux."
command -v curl >/dev/null 2>&1 || stop "This needs curl, to check that the room answers. Install curl, then run ./setup.sh again."
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
  if headless; then say "GitHub will show the app's settings filled in, in your laptop's browser. Press Create GitHub App there."
  else say "Your browser will open GitHub with the app's settings filled in. Press Create GitHub App there."; fi
  if headless; then
    say ""
    say "This computer has no screen. The GitHub step sends your browser to localhost:$APP_PORT, so on your laptop run, in another terminal:"
    say "  $(tunnel "$APP_PORT")"
    say "(use this server's address in place of $(hostname_) if it differs), leave it running, then come back here."
  fi
  ask GITHUB_APP_ID "Press Enter to start." >/dev/null
  node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$node_major" -ge 18 ] 2>/dev/null; then
    if headless; then node relay/github-app.js create --env "$ENV" --port "$APP_PORT" --no-open; else node relay/github-app.js create --env "$ENV"; fi
    install=""
  else
    image="ghcr.io/bfalkowski/building58:$(get BUILDING58_VERSION)"; [ "$image" = "ghcr.io/bfalkowski/building58:" ] && image="ghcr.io/bfalkowski/building58:latest"
    if curl -s -o /dev/null "http://127.0.0.1:$APP_PORT/" 2>/dev/null; then stop "Port $APP_PORT is in use. Free it, or run SETUP_APP_PORT=<another port> ./setup.sh"; fi
    say "No Node 18 or later here, so the GitHub step runs in a container. Getting $image..."
    docker pull -q "$image" >/dev/null || stop "Could not download $image."
    docker rm -f "$HELPER" >/dev/null 2>&1 || true
    docker create --name "$HELPER" -p "127.0.0.1:$APP_PORT:$APP_PORT" --entrypoint node "$image" /tmp/github-app.js create --print --host 0.0.0.0 --port "$APP_PORT" --no-open >/dev/null || stop "Could not make the helper container."
    docker cp -q relay/github-app.js "$HELPER:/tmp/github-app.js"
    out=$(mktemp)
    docker start -a "$HELPER" > "$out" 2>&1 &
    helper=$!
    for i in $(seq 60); do grep -q '^Opening' "$out" && break; kill -0 "$helper" 2>/dev/null || break; sleep 1; done
    grep -q '^Opening' "$out" || { cat "$out" >&2; rm -f "$out"; stop "The GitHub step did not start (is port $APP_PORT free?)."; }
    open_link "http://localhost:$APP_PORT/"
    headless || say "If no browser opened, open http://localhost:$APP_PORT/"
    wait "$helper" || true
    grep -q '^GITHUB_APP_ID=' "$out" || { cat "$out" >&2; rm -f "$out"; stop "The GitHub App was not made. Run ./setup.sh again."; }
    put GITHUB_APP_ID "$(sed -n 's/^GITHUB_APP_ID=//p' "$out")"
    put GITHUB_APP_PRIVATE_KEY "$(sed -n 's/^GITHUB_APP_PRIVATE_KEY=//p' "$out")"
    install=$(sed -n 's/^GITHUB_APP_INSTALL=//p' "$out")
    rm -f "$out"
    say "Saved the app's id and key in $ENV."
  fi
  [ -z "$(get GITHUB_APP_ID)" ] && stop "The GitHub App was not saved in $ENV. Run ./setup.sh again."
  if [ -n "$install" ]; then open_link "$install"; say "Install it on the repos the room works on: $install"; else say "Install it on the repos the room works on, with the link above, or on the page GitHub showed."; fi
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
if headless; then say "To open the room on your laptop, run $(tunnel "$port") there, then open the link below."; fi
say "The room is running. Open it: http://localhost:$port/office/?channel=office&key=<RELAY_KEY in $ENV>"
open_link "$link"
