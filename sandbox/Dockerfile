# Per-user code execution sandbox image (docs/superpowers/specs/2026-10-14-sandbox-design.md §3).
#
# The toolchains (uv and Python 3.12, Node and pnpm, bun, Playwright with Chromium) come prebuilt from
# github.com/OnlyChatHQ/sandbox-image, pinned by digest. Do not move them back here: Workers Builds
# has no layer cache, so every deploy rebuilt them from scratch. What stays here is tied to this
# repository's code. Playwright's version is quoted in the sandbox_exec tool description
# (src/plugins/sandbox/server/index.ts) and must match the base image's.
#
# Nothing may exist under /workspace in this image: restoring a backup over an
# image-provided directory fails with EXDEV.

FROM ghcr.io/onlychathq/sandbox-base:v1.0.0@sha256:d6bacb4a755d51e48f41f404f71cbe9b91e9637a601a02f515b8ed4b130e6484

# Used by Files / DirectoryBackup from @cloudflare/sandbox 1.0.1.
COPY --from=docker.io/cloudflare/sandbox:1.0.1 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

COPY bin/sandbox-run bin/job-run /opt/sandbox/bin/
RUN chmod 0755 /opt/sandbox/bin/sandbox-run /opt/sandbox/bin/job-run

# Debian's /etc/profile overwrites PATH for login shells, and commands run via
# `bash -lc`. Re-assert the image PATH after it (profile.d is sourced afterwards).
RUN printf '%s\n' \
      'export PATH=/opt/venv/bin:/workspace/home/.local/bin:/workspace/home/.bun/bin:/opt/sandbox/bin:/usr/local/bin:/usr/bin:/bin' \
      > /etc/profile.d/00-sandbox-path.sh

# Package caches stay in /tmp: under HOME they would ride along in every backup of the home unit.
ENV HOME=/workspace/home \
    PATH=/opt/venv/bin:/workspace/home/.local/bin:/workspace/home/.bun/bin:/opt/sandbox/bin:/usr/local/bin:/usr/bin:/bin \
    VIRTUAL_ENV=/opt/venv \
    UV_LINK_MODE=copy \
    npm_config_cache=/tmp/npm-cache \
    pnpm_config_store_dir=/tmp/pnpm-store \
    BUN_INSTALL_CACHE_DIR=/tmp/bun-cache \
    UV_TOOL_DIR=/workspace/home/.local/share/uv/tools \
    UV_TOOL_BIN_DIR=/workspace/home/.local/bin \
    NPM_CONFIG_PREFIX=/workspace/home/.local \
    PNPM_HOME=/workspace/home/.local/bin \
    BUN_INSTALL=/workspace/home/.bun \
    MPLBACKEND=Agg \
    LANG=C.UTF-8

WORKDIR /
# tini as PID 1 reaps orphans: background jobs detach on purpose, and `sleep` alone would leave each
# finished one behind as a zombie.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
