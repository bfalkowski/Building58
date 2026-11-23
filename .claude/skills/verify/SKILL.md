---
name: verify
description: Start a test room from this checkout on its own port with the stub env, open the room page in a browser, drive the change, read the real values, and stop the room. Use it before you commit a change to the room page (office/) or the relay's routes (relay/), so the pull request shows the real thing and not only unit tests.
---

# Verify a change in a running room

Run this from your task checkout, the folder you were told to stay in. It needs no keys and does
not touch the person's room: the room uses this checkout's own `.env` (placeholder values, its own
ports), a state folder in a temporary place, and a throwaway `HOME`.

## 1. Start the room

```bash
set -a; . ./.env; set +a
SCRATCH=/tmp/verify-$PORT; mkdir -p $SCRATCH
HOME=$SCRATCH/home RELAY_STATE_DIR=$SCRATCH/state PORT=$PORT RELAY_KEY=stub \
  RELAY_TERMINAL=1 RELAY_WORLD=office node relay/server.js > $SCRATCH/room.log 2>&1 &
echo $! > $SCRATCH/pid
until curl -sf http://127.0.0.1:$PORT/health >/dev/null; do sleep 0.5; done
```

This starts the same relay `npm run office` does, but you hold the supervisor's pid, so you can stop it in step 4. Each shell call starts fresh, so run the first two lines again in each later call.
- `PORT` comes from `.env` (the first of this checkout's two ports). Never use 8787 or `~/.office-world`: those are the person's room.
- `HOME` and `RELAY_STATE_DIR` keep the room away from the person's hooks, sessions and tickets.
- The room starts a Lead session in this folder. With the throwaway `HOME` it has no sign-in, so it does nothing.
- If `/health` does not answer within about 30 seconds, read `$SCRATCH/room.log`.

## 2. See the page

Open `http://127.0.0.1:$PORT/office/?channel=office&key=stub` in a browser. `playwright-core` is a
dev dependency, so with `node_modules` present:

```bash
npx playwright-core install chromium      # once per computer
```

Then drive it from a short script in `$SCRATCH`, not in the repo. `relay/test/browser/page.js` shows
how the repo's own browser tests do it: they answer the CDN links from `node_modules` and open the
page with WebGL off (`--disable-webgl --disable-3d-apis`), where the scene shows its fallback and
every panel still works. Use `--use-angle=swiftshader --enable-unsafe-swiftshader` only when you
need the scene drawn, since a page then takes seconds to load.

With no browser to install, say so in the pull request, and check the page and the routes with
`curl`. Say that is all you did.

## 3. Drive the change and read real values

- Do what a person would do with the change: click the control, type in the box, open the panel.
- Read what the page shows (`page.textContent`, `page.evaluate`) and what the relay answers (`curl -H "Authorization: Bearer stub" http://127.0.0.1:$PORT/channels/office/<route>`: routes sit under `/channels/<channel>`, and a wrong key answers 401). Do not only look that a step did not fail.
- Ticket routes ask GitHub for the issues, and with no `gh` login they answer `store`. Use a route that does not, such as `/settings` or `/rules`, or say you could not check the ticket routes.
- For a route, call it with a good request and a bad one, and compare the answer with its row in `docs/manual/relay.html`.
- Take a screenshot (`page.screenshot`) when how it looks is the change.
- Put in the pull request what you ran, the values you read, and what you could not check.

## 4. Stop the room and check nothing is left

```bash
kill -TERM $(cat $SCRATCH/pid); sleep 3
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:$PORT/health   # 000: nothing answers
pgrep -af "$PWD" | grep -v pgrep                                          # prints nothing
rm -rf $SCRATCH
```

The supervisor stops the relay, which stops its session host and the sessions in it.
If `pgrep` still lists a `relay/server.js`, `session-host.js`, `pty-bridge.py` or `claude` that runs from
this checkout, `kill` it by its pid and look again. Also stop a browser you started. Never stop a process
that runs from another folder: other tasks run there. Leave a room running only if the person asks.
