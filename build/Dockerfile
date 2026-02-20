# VLC.js WebAssembly Build — Multi-stage Dockerfile
#
# Builds VLC media player as a WebAssembly module using Emscripten.
# Output: experimental.js, experimental.wasm, experimental.worker.js
#
# Usage:
#   docker build -t vlcjs-builder .
#   docker run --rm -v $(pwd)/output:/output vlcjs-builder
#
# Or with docker compose:
#   docker compose up
#
# To upgrade Emscripten: change EMSDK_VERSION below and rebuild.
# To upgrade VLC: change VLC_COMMIT_HASH below and rebuild.
#   You may also need to update or add patches in vlc_patches/aug/.

# ---------------------------------------------------------------------------
# Stage 1: Base toolchain — Emscripten SDK + system build dependencies
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS toolchain

# ---- Version pins (change these to upgrade) ----
# Emscripten 4.0.1 is the version used by the upstream VideoLAN Docker image
# as of 2025. The upstream vlc.js compile.sh used 3.1.18 (2022-era), but that
# is incompatible with modern LLVM/Clang. 4.0.1 is tested and stable.
# To upgrade: change this value, then rebuild. Check the Emscripten changelog
# at https://github.com/emscripten-core/emscripten/blob/main/ChangeLog.md
# for breaking changes before upgrading.
ARG EMSDK_VERSION=4.0.1

# VLC source commit to build against. This is the commit hash from the
# upstream VLC repository that the patches are known to apply cleanly to.
# The original vlc.js used 06e361b127e4609e429909756212ed5e30e7d032.
# To upgrade: find a newer VLC commit, update this hash, and verify patches
# still apply. You may need to rebase patches for newer VLC versions.
ARG VLC_COMMIT_HASH=06e361b127e4609e429909756212ed5e30e7d032

ENV DEBIAN_FRONTEND=noninteractive

# Install system build dependencies required by VLC's configure/build system
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    libtool \
    libltdl-dev \
    automake \
    autoconf \
    autopoint \
    make \
    gettext \
    pkg-config \
    cmake \
    zip \
    bzip2 \
    p7zip-full \
    wget \
    dos2unix \
    ragel \
    yasm \
    g++ \
    m4 \
    ninja-build \
    ant \
    build-essential \
    libtool-bin \
    gperf \
    flex \
    bison \
    curl \
    nasm \
    meson \
    python3 \
    python3-pip \
    python3-setuptools \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Emscripten SDK
RUN git clone https://github.com/emscripten-core/emsdk.git /opt/emsdk \
    && cd /opt/emsdk \
    && ./emsdk install ${EMSDK_VERSION} \
    && ./emsdk activate ${EMSDK_VERSION}

# Make emsdk available in all subsequent RUN commands.
# We source emsdk_env.sh via a profile script so that every RUN shell picks
# up the correct paths automatically (including the node version bundled with
# whichever emsdk version is installed).
ENV EMSDK="/opt/emsdk"
ENV EM_CONFIG="/opt/emsdk/.emscripten"
RUN echo '. /opt/emsdk/emsdk_env.sh 2>/dev/null' >> /etc/bash.bashrc
# Also set a baseline PATH for non-interactive shells (RUN uses /bin/sh)
ENV PATH="/opt/emsdk:/opt/emsdk/upstream/emscripten:${PATH}"

# ---------------------------------------------------------------------------
# Stage 2: Build VLC to WebAssembly
# ---------------------------------------------------------------------------
FROM toolchain AS builder

ARG VLC_COMMIT_HASH=06e361b127e4609e429909756212ed5e30e7d032

# The upstream vlc.js repository commit to use for C source files (main.c,
# exports_*.c) and JS libraries (wasm-imports.js). These are wrapper files
# that bridge VLC's C API to the Emscripten/JavaScript interface.
# Use the incoming branch HEAD — this is where the WASM build lives upstream.
ARG VLCJS_BRANCH=incoming

WORKDIR /build

# Copy our adapted build scripts from the local build context
COPY compile.sh create_main.sh ./
RUN chmod +x compile.sh create_main.sh

# Clone the upstream vlc.js repository to get C source files, JS libraries,
# and the patch set. The compile.sh script handles cloning VLC itself.
RUN git clone --branch ${VLCJS_BRANCH} --single-branch --depth 1 \
    https://code.videolan.org/jbk/vlc.js.git vlcjs-upstream

# Set up the expected directory layout for compile.sh and create_main.sh:
#   ./vlc_patches/aug/  — VLC patches from upstream vlc.js
#   ./src/              — C source files for the emcc link step
#   ./js-libs/          — Custom JS library files for emcc
RUN cp -r vlcjs-upstream/vlc_patches ./vlc_patches \
    && mkdir -p src js-libs \
    && cp vlcjs-upstream/main.c vlcjs-upstream/exports_media_player.c \
          vlcjs-upstream/exports_media.c ./src/ \
    && cp vlcjs-upstream/lib/wasm-imports.js ./js-libs/

# Build VLC (this is the longest step — compiles VLC + all contribs for WASM)
# SLOW_MODE=1 builds contribs from source (required for WASM cross-compile)
RUN bash compile.sh

# ---------------------------------------------------------------------------
# Stage 3: Extract just the output artifacts
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS output

RUN mkdir -p /output

# Copy the three output files that constitute the VLC.js WASM build
COPY --from=builder /build/experimental.js /output/
COPY --from=builder /build/experimental.wasm /output/
COPY --from=builder /build/experimental.worker.js /output/

# Default command: copy artifacts to the /output volume mount
# When run with: docker run -v $(pwd):/output vlcjs-builder
# the artifacts will appear in the host directory.
CMD ["sh", "-c", "cp /output/experimental.* /host-output/ 2>/dev/null && echo 'Build artifacts copied to /host-output/' || echo 'Artifacts available in /output/ — mount a volume to /host-output/ to extract them'"]
