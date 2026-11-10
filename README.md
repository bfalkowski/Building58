# Building58

A building of rooms where Claude Code sessions work. Each room is a 3D loft that runs like a
squad: a Lead, Devs, reviewers and a PM, with you as the manager. Each developer is one of your
Claude Code sessions. Everything a room shows comes from real state: sessions, tickets, tasks and
pull requests.

A room is a world: a browser page with the API `window.run`. Other worlds can live in repos of
their own and be linked in. The relay passes commands from outside callers (curl, a
script, a coding agent's hooks) to whichever world is open.

| World | Folder | What it is |
| --- | --- | --- |
| Room | [`office/`](office/README.md) | A loft in New York. Each developer is one of your Claude Code sessions. They work at their desk, raise a hand when the session needs you, and get coffee when it is done. Click someone to open their session. |

## Run them

Node 18 or later. No packages to install.

Each world runs on a relay of its own, with its own port and key, so one world's restart or key
does not touch another:

```
RELAY_KEY=key-one npm run office               # the office, on 8787
RELAY_KEY=key-two npm run world -- <folder>    # another world, on the port in its world.json
```

Each prints its link, for example `http://localhost:8787/office/?channel=office&key=key-one`.
A world can live in a repo of its own and be linked in as a folder: the relay finds any folder
with a `world.json`. See [Worlds](docs/manual/relay.html#worlds).
`RELAY_KEY=pick-a-key npm run relay` still serves every world from one relay on 8787. See
[One relay per world](docs/manual/relay.html#one-relay).

Or let one command start the relay and open the page:

```
RELAY_KEY=pick-a-key npm run office        # the office, waiting for Claude Code
RELAY_KEY=pick-a-key npm run office:demo   # the office, with pretend Claude Code sessions
```

To connect Claude Code to the room, see [office/README.md](office/README.md). Without the
relay, serve the folder (`python3 -m http.server`) and open `office/`. The room works on its own,
and has a demo button.

The room's briefs name skills from two Claude Code plugins, if they are installed:
`mattpocock-skills` from `claude-plugins-official`, and `pstack` from `cursor-plugins`. In Claude
Code, run `/plugin install mattpocock-skills@claude-plugins-official`, then
`/plugin marketplace add cursor/plugins` and `/plugin install pstack@cursor-plugins`. The room
works without them: a brief names only the skills installed, and the chat board says which are
missing. See [Models and skills](docs/manual/settings.html#models).

## Lint and test

Running the worlds needs no install. ESLint is a dev dependency, so install it once to lint:

```
npm ci
npm run lint
npm test
```

The tests need `python3` and `git`. Lint checks for mistakes only, not style, so long lines are fine.
`npm test` runs each test file with its own empty home folder, so the tests never touch your
room's files, and several checkouts can run it at the same time. A file that has not ended after
10 minutes (`TEST_FILE_SECONDS` sets it) is stopped with everything it started, and fails, so one
stuck file cannot hang the run. A file you run with `node --test`
yourself gets your own home folder.

The browser tests open the room page in a headless Chromium, against a real relay. They need
Node 20 or later. Install that browser once, then run them:

```
npx playwright-core install chromium
npm run test:browser
```

A failed test leaves a screenshot and the page's console in `test-results/browser/`.

GitHub runs lint, `npm test` and the room's browser tests on every pull request, on the current LTS, as jobs that run side by side on arm64 Linux runners, the cheaper kind. A pull request waits for the slowest job, not for all of them in a row. A change to docs only runs just the manual's checks. A last job named `pipeline`, the check `main` requires, passes when every job passed or was skipped. GitHub runs lint and `npm test` on Node 18
too once a week, and when you press Run workflow on the CI workflow in Actions, and those runs include every test. Nothing runs on a push to `main`, since the pull request already passed. In the room, an automatic review waits until a pull request's
pipeline is green. See [A clean pipeline before review](docs/manual/roles.html#pipeline).

A pre-commit hook stops commits that add keys or passwords. `npm ci` turns it on, or run
`npm run hooks` once, which needs no install. For a false alarm, put `secret-check: allow` on
that line. It looks for known patterns, so it can miss a secret, and `--no-verify` skips it. CI runs
the same check on what each pull request adds, so a secret that gets past the hook still fails the
`pipeline` check. See [Guards at each boundary](docs/manual/how-it-works.html#guards).

## The manual

How the room and the relay behave is in one place, the manual in
[docs/manual/](docs/manual/index.html). The pages are HTML, so GitHub shows their source. Read
them at `http://localhost:8787/docs/manual/` while the relay runs, or open the files. It has the relay's
calls and routes, every setting, and where each part of the code lives. The rules for sessions
are in [CLAUDE.md](CLAUDE.md) and [docs/constitution.md](docs/constitution.md).
