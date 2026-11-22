#!/bin/sh
# Runs the container smoke test (relay/test/container/smoke.js) in a new container from an image,
# with the fake claude in place of Claude Code. Usage: docker/smoke.sh [image], default building58:local.
set -eu
IMAGE="${1:-building58:local}"
NAME="building58-smoke-$$"
VERSION=$(docker run --rm --entrypoint claude "$IMAGE" --version | cut -d' ' -f1)
docker run -d --name "$NAME" \
  -e RELAY_KEY=smoke-test-key \
  -e CLAUDE_CODE_VERSION="$VERSION" \
  -e CLAUDE_CMD=/home/node/building58/relay/test/fake-claude.sh \
  "$IMAGE" >/dev/null
status=0
docker exec "$NAME" sh -c 'until [ -f /home/node/building58/relay/test/container/smoke.js ]; do sleep 1; done; node /home/node/building58/relay/test/container/smoke.js' || status=$?
if [ "$status" -ne 0 ]; then echo "The relay said:"; docker logs "$NAME" 2>&1 | tail -60; fi
docker rm -f "$NAME" >/dev/null
exit "$status"
