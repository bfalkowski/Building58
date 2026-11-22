#!/bin/sh
# Runs the container smoke test in a new container from an image, with the fake claude in place of
# Claude Code: relay/test/container/smoke.js inside the container, then relay/test/container/from-host.js
# from the host, through the port the container publishes on 127.0.0.1.
# Usage: docker/smoke.sh [image], default building58:local. SMOKE_PORT picks the port, default 18787.
set -eu
IMAGE="${1:-building58:local}"
PORT="${SMOKE_PORT:-18787}"
KEY="smoke-test-key-$$"
NAME="building58-smoke-$$"
HERE=$(cd "$(dirname "$0")/.." && pwd)
VERSION=$(docker run --rm --entrypoint claude "$IMAGE" --version | cut -d' ' -f1)
docker run -d --name "$NAME" \
  -p "127.0.0.1:$PORT:8800" \
  -e PORT="$PORT" \
  -e RELAY_KEY="$KEY" \
  -e CLAUDE_CODE_VERSION="$VERSION" \
  -e CLAUDE_CMD=/home/node/building58/relay/test/fake-claude.sh \
  "$IMAGE" >/dev/null
status=0
docker exec "$NAME" sh -c 'until [ -f /home/node/building58/relay/test/container/smoke.js ]; do sleep 1; done; node /home/node/building58/relay/test/container/smoke.js' || status=$?
if [ "$status" -eq 0 ]; then SMOKE_PORT="$PORT" SMOKE_KEY="$KEY" node "$HERE/relay/test/container/from-host.js" || status=$?; fi
if [ "$status" -ne 0 ]; then echo "The container said:"; docker logs "$NAME" 2>&1 | tail -60; fi
docker rm -f "$NAME" >/dev/null
exit "$status"
