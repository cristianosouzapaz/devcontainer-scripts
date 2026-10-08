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

# Cache-buster for the scripts fetch RUN below, keyed to ${SCRIPTS_REF}'s commit.
ADD https://api.github.com/repos/${SCRIPTS_REPO}/commits/${SCRIPTS_REF} /tmp/scripts.rev

# Fetch the setup scripts from the immutable commit Docker cached above, then seed the
# first release through the same root bootstrap used at runtime.
RUN mkdir -p /tmp/dc-init \
    && node --input-type=module -e " \
      import {readFileSync} from 'node:fs'; \
      const repo = process.env.SCRIPTS_REPO; \
      const sha = JSON.parse(readFileSync('/tmp/scripts.rev', 'utf8')).sha; \
      if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid scripts SHA'); \
      const res = await fetch('https://github.com/' + repo + '/archive/' + sha + '.tar.gz'); \
      if (!res.ok) throw new Error('Download failed: ' + res.status + ' ' + res.statusText); \
      const buf = Buffer.from(await res.arrayBuffer()); \
      const {spawnSync} = await import('child_process'); \
      const r = spawnSync('tar', ['-xz', '-C', '/tmp/dc-init', '--strip-components=1'], {input: buf}); \
      if (r.status !== 0) throw new Error('tar failed: ' + (r.stderr || Buffer.alloc(0)).toString()); \
    " \
    && mv /tmp/dc-init/scripts /opt/devcontainer \
    && SCRIPTS_REF="$(jq -r '.sha' /tmp/scripts.rev)" SCRIPTS_REPO="$SCRIPTS_REPO" bash /opt/devcontainer/installer/install.sh \
    && rm -rf /tmp/dc-init /tmp/scripts.rev \
    && find /opt/devcontainer -name "*.sh" -exec chmod +x {} + \
    && chmod +x /opt/devcontainer/bin/* \
    && install -m 0755 /opt/devcontainer/bin/* /usr/local/bin/ \
    && ln -sf /opt/devcontainer/bin/devcontainer-data /usr/local/bin/devcontainer-data \
    && ln -sf /opt/devcontainer/bin/devcontainer-install /usr/local/bin/devcontainer-install

# Install herdr, verified against its published checksum. HERDR_VERSION is empty
# by default (latest release); set it to pin a release and bust this layer.
ARG HERDR_VERSION=""
RUN set -eux; \
    case "$(uname -m)" in \
        x86_64) herdr_arch='x86_64' ;; \
        aarch64|arm64) herdr_arch='aarch64' ;; \
        *) exit 1 ;; \
    esac; \
    if [ -n "${HERDR_VERSION}" ]; then \
        herdr_release_url="https://api.github.com/repos/herdrdev/herdr/releases/tags/${HERDR_VERSION}"; \
    else \
        herdr_release_url='https://api.github.com/repos/herdrdev/herdr/releases/latest'; \
    fi; \
    release_file="$(mktemp)"; \
    curl --fail --location --silent --show-error \
        "$herdr_release_url" \
        --output "$release_file"; \
    herdr_asset="herdr-linux-${herdr_arch}"; \
    herdr_url="$(jq -r --arg asset "$herdr_asset" '.assets[] | select(.name == $asset) | .browser_download_url' "$release_file")"; \
    herdr_digest="$(jq -r --arg asset "$herdr_asset" '.assets[] | select(.name == $asset) | .digest' "$release_file")"; \
    test -n "$herdr_url" && test "$herdr_url" != null; \
    test "${herdr_digest#sha256:}" != "$herdr_digest"; \
    curl --fail --location --silent --show-error "$herdr_url" --output /tmp/herdr; \
    printf '%s  %s\n' "${herdr_digest#sha256:}" /tmp/herdr | sha256sum --check --status; \
    install -D -m 0755 /tmp/herdr /usr/local/lib/herdr/herdr; \
    rm -f /tmp/herdr "$release_file"

# Pre-create the workspace folder and its schema marker in the image so a freshly
# created project volume already has them before any lifecycle command runs.
ARG PROJECT_NAME="project-name"
RUN mkdir -p "/workspace/${PROJECT_NAME}" /workspace/.metadata \
    && jq -r '.persistentDataLayoutVersion' /opt/devcontainer/inventory.json > /workspace/.metadata/.schema-version
