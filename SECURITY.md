# Security

## Report a problem in private

If you find a security problem in Building58, report it in private. Do not open an issue, a pull
request or a discussion about it, since those are public.

1. Go to the **Security** tab of this repo.
2. Press **Report a vulnerability**.
3. Say what you found, how to make it happen, and which version or commit you ran.

Only the maintainer sees the report. You get an answer in the report's thread.

## What counts

Anything that lets a person or a text reach more than it should, for example:

- A request from another site, another computer or a tunnel that a local-only route answers.
- A session token that reaches a route its role should not reach.
- Text from an issue, a pull request, a comment or a web page that steers a session to act.
- A key or a sign-in that shows up in a log, a URL, a brief, a ticket or a commit.
- A way to change what a room runs without a merge to main.

## What happens next

The fix is made in private, through a draft security advisory. When the fix is merged, the advisory
is published with what was wrong and which versions are safe.

Building58 is a personal project run by one person, so there is no promised time for an answer.
