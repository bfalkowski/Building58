# The room

A loft in New York. Each developer is one of your Claude Code sessions. They type at
their desk while the session works, raise a hand when it needs you, and get coffee when its turn
ends. Click someone to see their session.

How the room behaves is in the manual, [docs/manual/](../docs/manual/index.html), which the
relay serves at `http://localhost:8787/docs/manual/`. GitHub shows those pages as source, so read
them there or open the files. The **How work moves** link in the room opens it. This file is
only for setting the room up.

## Run it

Node 18 or later, `git`, and for the Claude Code panel `python3` and `claude` on your `PATH`.
No packages to install.

```
RELAY_KEY=pick-a-key npm run office
```

Open the link it prints if no browser opens. To try it without Claude Code, with three pretend
sessions:

```
RELAY_KEY=pick-a-key npm run office:demo
```

Without the relay, open `office/` from any web server and press **Run a demo**.

What these do: [Starting the room](../docs/manual/running.html#start).

## Connect Claude Code

From the room page: type a folder in the **Claude Code** panel and press **Add worker**, once
per session. See [The Claude Code panel](../docs/manual/running.html#panel).

From your own terminal: start the room as above and leave the page open, then add the hooks to
`~/.claude/settings.json` once, and start a new Claude Code session.

```
RELAY_KEY=pick-a-key npm run office:hooks
```

To take them out: `node relay/office-hook.js --uninstall`. Add them again if you change the
relay's key. Add them from the relay's own folder: if they run `office-hook.js` from another
checkout, such as an old worktree, the page warns under **Add worker** and shows the command to
run. See [the warning](../docs/manual/running.html#hooks-checkout), [Sessions from your own
terminal](../docs/manual/running.html#own-terminal) and [What the hook sends](../docs/manual/how-it-works.html#hook-sends).

## Where to read on

- [How the room works](../docs/manual/how-it-works.html): the map, a ticket's life, hooks, and the code.
- [Running it](../docs/manual/running.html): restarts, Update, copies of the repo, GitHub issues, common messages.
- [When the new relay fails](../docs/manual/running.html#rollback): with `RELAY_ROLLBACK=1`, Update goes back to
  the last commit that worked, and the page says which commit failed and which one runs.
- [The session host](../docs/manual/running.html#session-host): a relay restart, such as Update's, leaves every
  session running with its output. Stopping the relay ends them, and the next start brings them back.
- [Roles and how work moves](../docs/manual/roles.html): what you do, the Lead, reviews, huddles.
- [How tired the Lead is](../docs/manual/roles.html#lead-tired): how full the Lead's context is (fresh, getting
  tired, needs a refresh), where you see it, and what **Refresh the Lead** does about it.
- [Where the PM reads](../docs/manual/running.html#pm-checkout): **Ask the PM** reads the branch you typed at
  the remote's latest commit, in a checkout of its own that goes when the PM ends. Your folder is not changed.
- [The PM sets the order](../docs/manual/roles.html#pm-order): with **Let the PM set the order** on in
  Settings (off by default), the PM can run `ticket.js priority T-5 high` and `ticket.js order T-5 --before T-4`
  on tickets in Triage or Ready.
- [The Lead sets priority](../docs/manual/roles.html#lead-order): **Let the Lead set priority** (off by
  default) lets the Lead run the same two commands, on tickets in Triage or Ready.
- [Editing a ticket](../docs/manual/roles.html#edit): **Edit** on a Triage or Ready card changes its title, body
  and priority. The PM and the Lead run `ticket.js edit T-5 --title "New title"`. Each edit is in the ticket's history.
- [The COO](../docs/manual/roles.html#coo): what **Ask the COO** does (a one-page report on how the room
  runs, with at most 3 recommendations) and does not do (it proposes only: no code, tickets, starts,
  stops, merges, board moves or switches).
- [The security officer](../docs/manual/roles.html#security): what **Ask security** does (a one-page report on
  what access the sessions run with, by name only, against article 7, with at most 3 recommendations) and does
  not do (it proposes only and does not decide).
- [The relay API and routes](../docs/manual/relay.html): `window.run`, the routes and `relay/ticket.js`.
- [Settings](../docs/manual/settings.html): every environment variable.
