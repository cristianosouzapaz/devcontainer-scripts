# syntax=docker/dockerfile:1
ARG NODE_IMAGE="node:lts-slim"
FROM ${NODE_IMAGE}

# python3 provides the stdlib the herdr Claude Code hook needs (the base image
# ships only python3-minimal, which lacks json/socket).
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates coreutils curl jq python3 \
    && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/root/.local/share/pnpm \
    PATH=/root/.local/share/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

ENV CLAUDE_CONFIG_DIR=/root/.claude \
    CODEX_HOME=/root/.codex \
    PI_CODING_AGENT_DIR=/root/.pi/agent

ARG SCRIPTS_REF="main"
ARG SCRIPTS_REPO="cristianosouzapaz/devcontainer-scripts"
ENV SCRIPTS_REF=${SCRIPTS_REF} \
    SCRIPTS_REPO=${SCRIPTS_REPO}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Reject malformed fork coordinates before using the build argument in a GitHub URL.
RUN node -e "process.exit(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(process.env.SCRIPTS_REPO || '') ? 0 : 1)"

# Fetch the setup scripts at ${SCRIPTS_REF}: BuildKit resolves the ref to a commit on every
# build, so the commit itself invalidates the cache, and the kept .git/HEAD hands that commit
# to image-bootstrap.sh, which seeds the first installer release from the same commit.
ADD --keep-git-dir=true https://github.com/${SCRIPTS_REPO}.git#${SCRIPTS_REF} /tmp/dc-init
RUN bash /tmp/dc-init/scripts/image-bootstrap.sh /tmp/dc-init

# Install herdr, verified against its published checksum, with the scripts tree's
# installer, which the CI Bash job also runs. Its path is an interface between this
# Dockerfile and the scripts tree. HERDR_VERSION is empty by default (latest release);
# set it to pin a release and bust this layer.
ARG HERDR_VERSION=""
RUN bash /opt/devcontainer/herdr-install.sh /usr/local/lib/herdr/herdr

# Pre-create the workspace folder and its schema marker in the image so a freshly
# created project volume already has them before any lifecycle command runs.
ARG PROJECT_NAME="project-name"
RUN mkdir -p "/workspace/${PROJECT_NAME}" /workspace/.metadata \
    && jq -r '.persistentDataLayoutVersion' /opt/devcontainer/inventory.json > /workspace/.metadata/.schema-version
