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
# To upgrade VLC: change VLC_TESTED_HASH below and rebuild.

# ---------------------------------------------------------------------------
# Stage 1: Base toolchain — Emscripten SDK + system build dependencies
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS toolchain

# ---- Version pins (change these to upgrade) ----
#
# Emscripten 4.0.1 — matches the version used by VLC's official CI pipeline.
# Updated from 3.1.18 (vlc.js 2022-era) to match upstream VideoLAN CI.
# See: https://code.videolan.org/videolan/vlc/-/commit/f6ebf56c
# Changelog: https://github.com/emscripten-core/emscripten/blob/main/ChangeLog.md
ARG EMSDK_VERSION=4.0.1

# VLC source commit — target VLC master (4.0-dev) which has BUILT-IN wasm
# support at extras/package/wasm-emscripten/build.sh.
#
# Previously used: 06e361b1 (2022-era, required 20+ external patches)
# Now using: 65e744b0 (2026-01-29, latest wasm-emscripten build.sh change)
#
# VLC master has native WASM support with active CI — no external patches
# needed for the core build. Only vlc.js-specific wrapper patches are applied.
#
# To find newer commits: https://code.videolan.org/videolan/vlc/-/commits/master
# Filter for: extras/package/wasm-emscripten
ARG VLC_TESTED_HASH=65e744b0

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
    python3-venv \
    python3-setuptools \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Emscripten SDK
RUN git clone https://github.com/emscripten-core/emsdk.git /opt/emsdk \
    && cd /opt/emsdk \
    && ./emsdk install ${EMSDK_VERSION} \
    && ./emsdk activate ${EMSDK_VERSION}

# Make emsdk available in all subsequent RUN commands
ENV EMSDK="/opt/emsdk"
ENV EM_CONFIG="/opt/emsdk/.emscripten"
RUN echo '. /opt/emsdk/emsdk_env.sh 2>/dev/null' >> /etc/bash.bashrc
ENV PATH="/opt/emsdk:/opt/emsdk/upstream/emscripten:${PATH}"

# ---------------------------------------------------------------------------
# Stage 2: Build VLC to WebAssembly
# ---------------------------------------------------------------------------
FROM toolchain AS builder

ARG VLC_TESTED_HASH=65e744b0

WORKDIR /build

# Copy our build scripts, wrapper patches, and vlc.js wrapper sources
COPY compile.sh create_main.sh patch_vlcjs_wrappers.sh ./
RUN chmod +x compile.sh create_main.sh patch_vlcjs_wrappers.sh

# Copy ported WebCodec sources — injected into VLC tree by compile.sh
# (bypasses git am which fails against VLC 4.0 due to API drift)
COPY webcodec/ webcodec/
COPY audio/ audio/

# Copy webaudio.js library — provides bridge functions (webaudio_getSampleRate,
# webaudio_getChannels, webaudio_init) called by the WASM audio output module
COPY js-libs/ js-libs/

# Clone the upstream vlc.js repository to get the C wrapper files
# (main.c, exports_media_player.c, exports_media.c) and JS libraries
# (wasm-imports.js) that bridge VLC's C API to JavaScript.
ARG VLCJS_BRANCH=incoming
RUN git clone --branch ${VLCJS_BRANCH} --single-branch --depth 1 \
    https://code.videolan.org/jbk/vlc.js.git vlcjs-upstream

# Set up wrapper sources for the final link step
RUN mkdir -p src js-libs \
    && cp vlcjs-upstream/main.c vlcjs-upstream/exports_media_player.c \
          vlcjs-upstream/exports_media.c ./src/ \
    && cp vlcjs-upstream/lib/wasm-imports.js ./js-libs/ \
    # Keep vlc.js patches in case any are still needed for wrapper integration
    && cp -r vlcjs-upstream/vlc_patches ./vlc_patches 2>/dev/null || true

# Patch the vlc.js C wrapper files for VLC 4.0 API compatibility
# (new function signatures, removed APIs)
RUN bash patch_vlcjs_wrappers.sh ./src

# Build VLC (longest step — compiles VLC + all contribs for WASM)
RUN bash compile.sh

# ---------------------------------------------------------------------------
# Stage 3: Extract just the output artifacts
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS output

RUN mkdir -p /output

COPY --from=builder /build/experimental.js /output/
COPY --from=builder /build/experimental.wasm /output/
# worker.js may not be generated in newer Emscripten (worker code embedded in main JS)
# audio-worklet-processor.js may be in a different path in VLC 4.0
RUN --mount=from=builder,source=/build,target=/build-src \
    cp /build-src/experimental.worker.js /output/ 2>/dev/null || true && \
    find /build-src/vlc -name "audio-worklet-processor.js" -exec cp {} /output/ \; 2>/dev/null || true

CMD ["sh", "-c", "cp /output/experimental.* /host-output/ 2>/dev/null && cp /output/audio-worklet-processor.js /host-output/vlc/modules/audio_output/webaudio/ 2>/dev/null; echo 'Build artifacts copied to /host-output/' || echo 'Artifacts available in /output/ — mount a volume to /host-output/ to extract them'"]
