# A Building58 room in a container. See docs/manual/running.html#container.
#
# The image holds the tools. The volumes hold what must survive a rebuild: the Building58 folder
# (the relay updates itself there), the state folder, Claude Code's folder and the repos.
FROM node:26-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.330

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git gnupg procps python3 tini \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# One Claude Code version, and no self-update: a new version changes only with a new image.
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force
ENV DISABLE_AUTOUPDATER=1

# The code the first start copies into the Building58 volume, with its git history, so Update works there.
COPY --chown=node:node . /opt/building58
COPY docker/start.sh /usr/local/bin/building58

RUN install -d -o node -g node /home/node/building58 /home/node/.office-world /home/node/.claude /home/node/repos

USER node
WORKDIR /home/node
ENV HOST=127.0.0.1 PORT=8787 FORWARD_PORT=8800 RELAY_TERMINAL=1
EXPOSE 8800

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.FORWARD_PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/building58"]
