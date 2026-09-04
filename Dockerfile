ARG NODE_IMAGE="node:lts-slim"
FROM ${NODE_IMAGE}

# python3 provides the stdlib the herdr Claude Code hook needs (the base image
# ships only python3-minimal, which lacks json/socket).
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl jq python3 \
    && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/root/.local/share/pnpm \
    PATH=/root/.local/share/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

ENV CLAUDE_CONFIG_DIR=/root/.claude \
    CODEX_HOME=/root/.codex

ARG SCRIPTS_REF="main"
ARG SCRIPTS_REPO="cristianosouzapaz/devcontainer-scripts"
ENV SCRIPTS_REF=${SCRIPTS_REF}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Fetch the setup scripts and put the bin/ entrypoints on PATH.
RUN mkdir -p /tmp/dc-init \
    && node --input-type=module -e " \
      const res = await fetch('https://github.com/${SCRIPTS_REPO}/archive/refs/heads/${SCRIPTS_REF}.tar.gz'); \
      if (!res.ok) throw new Error('Download failed: ' + res.status + ' ' + res.statusText); \
      const buf = Buffer.from(await res.arrayBuffer()); \
      const {spawnSync} = await import('child_process'); \
      const r = spawnSync('tar', ['-xz', '-C', '/tmp/dc-init', '--strip-components=1'], {input: buf}); \
      if (r.status !== 0) throw new Error('tar failed: ' + (r.stderr || Buffer.alloc(0)).toString()); \
    " \
    && mv /tmp/dc-init/scripts /opt/devcontainer \
    && rm -rf /tmp/dc-init \
    && find /opt/devcontainer -name "*.sh" -exec chmod +x {} + \
    && chmod +x /opt/devcontainer/bin/* \
    && install -m 0755 /opt/devcontainer/bin/* /usr/local/bin/ \
    && ln -sf /opt/devcontainer/bin/devcontainer-data /usr/local/bin/devcontainer-data

# Install the latest herdr release, verified against its published checksum.
RUN set -eux; \
    case "$(uname -m)" in \
        x86_64) herdr_arch='x86_64' ;; \
        aarch64|arm64) herdr_arch='aarch64' ;; \
        *) exit 1 ;; \
    esac; \
    release_file="$(mktemp)"; \
    curl --fail --location --silent --show-error \
        'https://api.github.com/repos/herdrdev/herdr/releases/latest' \
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
    && jq -r '.schemaVersion' /opt/devcontainer/config/persistent-data.json > /workspace/.metadata/.schema-version
