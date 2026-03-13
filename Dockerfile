ARG NODE_IMAGE="node:lts-slim"
FROM ${NODE_IMAGE}

# SET ENVIRONMENT VARIABLES FOR PNPM CONFIGURATION
ENV PNPM_HOME=/root/.local/share/pnpm \
    PATH=/root/.local/share/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# DOWNLOAD SETUP SCRIPTS FROM REPO
ARG SCRIPTS_REF="main"
ARG SCRIPTS_REPO="cristianosouzapaz/devcontainer-scripts"

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
    && find /opt/devcontainer -name "*.sh" -exec chmod +x {} +
