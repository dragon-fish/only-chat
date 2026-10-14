# Per-user code execution sandbox image (docs/superpowers/specs/2026-10-14-sandbox-design.md §3).
#
# Toolchains live in /opt and /usr/local so the backed-up HOME stays small.
# Nothing may exist under /workspace in this image: restoring a backup over an
# image-provided directory fails with EXDEV.

FROM debian:trixie-slim

ARG UV_VERSION=0.12.21
ARG NODE_VERSION=24.21.0
ARG PNPM_VERSION=12.8.2
ARG BUN_VERSION=1.4.2

# Build-time proxy only (ARG is not persisted in the image environment).
ARG http_proxy
ARG https_proxy

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git curl ca-certificates zip unzip jq ripgrep tmux procps less file build-essential xz-utils tini \
 && rm -rf /var/lib/apt/lists/*

# uv, Python 3.12 (python/python3 in /usr/local/bin) and the default venv.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_PYTHON_BIN_DIR=/usr/local/bin \
    UV_CACHE_DIR=/tmp/uv-cache
RUN set -eux; \
    case "$(uname -m)" in x86_64) a=x86_64;; aarch64) a=aarch64;; *) exit 1;; esac; \
    f="uv-${a}-unknown-linux-gnu.tar.gz"; u="https://github.com/astral-sh/uv/releases/download/${UV_VERSION}"; \
    cd /tmp; curl -fsSLO "$u/$f"; curl -fsSLO "$u/$f.sha256"; sha256sum -c "$f.sha256"; \
    tar -xzf "$f" --strip-components=1 -C /usr/local/bin "uv-${a}-unknown-linux-gnu/uv" "uv-${a}-unknown-linux-gnu/uvx"; \
    rm -f "$f" "$f.sha256"; \
    uv python install 3.12 --default; \
    uv venv /opt/venv --python 3.12; \
    VIRTUAL_ENV=/opt/venv uv pip install --link-mode=copy \
      numpy pandas matplotlib requests openpyxl pillow beautifulsoup4 lxml; \
    rm -rf /tmp/uv-cache

# Node.js (official binary tarball) and pnpm.
RUN set -eux; \
    case "$(uname -m)" in x86_64) a=x64;; aarch64) a=arm64;; *) exit 1;; esac; \
    f="node-v${NODE_VERSION}-linux-${a}.tar.xz"; u="https://nodejs.org/dist/v${NODE_VERSION}"; \
    cd /tmp; curl -fsSLO "$u/$f"; curl -fsSLO "$u/SHASUMS256.txt"; \
    grep " $f\$" SHASUMS256.txt | sha256sum -c -; \
    tar -xJf "$f" -C /usr/local --strip-components=1 --no-same-owner \
      --exclude='*/CHANGELOG.md' --exclude='*/LICENSE' --exclude='*/README.md'; \
    rm -f "$f" SHASUMS256.txt; \
    NPM_CONFIG_PREFIX=/usr/local npm install -g "pnpm@${PNPM_VERSION}"; \
    rm -rf /root/.npm /tmp/*

# bun (official release zip).
RUN set -eux; \
    case "$(uname -m)" in x86_64) a=x64;; aarch64) a=aarch64;; *) exit 1;; esac; \
    f="bun-linux-${a}.zip"; u="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"; \
    cd /tmp; curl -fsSLO "$u/$f"; curl -fsSLO "$u/SHASUMS256.txt"; \
    grep " $f\$" SHASUMS256.txt | sha256sum -c -; \
    unzip -q "$f"; install -m 0755 "bun-linux-${a}/bun" /usr/local/bin/bun; \
    ln -s bun /usr/local/bin/bunx; \
    rm -rf /tmp/*

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
