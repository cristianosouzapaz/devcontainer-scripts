# syntax=docker/dockerfile:1
ARG NODE_IMAGE="node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c"
FROM ${NODE_IMAGE}

# python3 provides the stdlib the herdr Claude Code hook needs (the base image
# ships only python3-minimal, which lacks json/socket). libatomic1 lets a Node feature
# version newer than the base image's run: Node 26 links against libatomic.so.1.
# hadolint ignore=DL3008
RUN apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install -y --no-install-recommends ca-certificates coreutils curl jq libatomic1 python3 \
    && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/root/.local/share/pnpm \
    PATH=/root/.local/share/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# gh reads GH_BROWSER before BROWSER, and VS Code never sets it, so gh --web reaches the stable
# wrapper even in terminals where VS Code overrides BROWSER.
ENV GH_BROWSER=/usr/local/bin/devcontainer-browser

ENV CLAUDE_CONFIG_DIR=/root/.claude \
    CODEX_HOME=/root/.codex \
    PI_CODING_AGENT_DIR=/root/.pi/agent

# SCRIPTS_REF defaults to the release tag this Dockerfile ships in: release-please bumps it in
# each release PR, and a published tag never moves, so one Dockerfile builds one script tree.
# x-release-please-start-version
ARG SCRIPTS_REF="v4.4.2"
# x-release-please-end
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
# installer, which the Bash test runner also runs. Its path is an interface between this
# Dockerfile and the scripts tree. HERDR_VERSION is the one herdr pin: the test runners read
# the release they install from this default too.
# The per-architecture sha256 pins of the release HERDR_SHA256_VERSION names let the installer
# download the asset directly, with no lookup through the GitHub REST API, whose unauthenticated
# budget the whole host IP shares; Renovate bumps them with the version. An overridden
# HERDR_VERSION skips the pins and verifies against the digest GitHub publishes. An optional
# github_token build secret authenticates any API call without entering a layer.
ARG HERDR_SHA256_VERSION="v0.9.5"
ARG HERDR_SHA256_X86_64="14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d"
ARG HERDR_SHA256_AARCH64="17d7536f2da50859523680ef279dffcac8e4a235f4e46fe8da6c2ec44141897c"
ARG HERDR_VERSION="v0.9.5"
RUN --mount=type=secret,id=github_token,env=GITHUB_TOKEN \
    bash /opt/devcontainer/herdr-install.sh /usr/local/lib/herdr/herdr

# Pre-create the workspace folder in the image so a freshly created project volume already has
# it before any lifecycle command runs; image-bootstrap.sh seeded the schema marker beside it.
ARG PROJECT_NAME="project-name"
RUN mkdir -p "/workspace/${PROJECT_NAME}" /workspace/.metadata
