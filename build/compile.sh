#!/bin/bash
# compile.sh — Build VLC as a WebAssembly module using Emscripten
#
# This script uses VLC's BUILT-IN wasm-emscripten build infrastructure
# (extras/package/wasm-emscripten/build.sh) which is part of VLC master.
#
# The old vlc.js approach (2022) required 20+ external patches. Modern VLC
# master has native WASM support including audio worklet output, WebGL video
# output, and Emscripten threading — no core patches needed.
#
# Flow:
#   1. Activate Emscripten SDK
#   2. Clone VLC master at TESTED_HASH
#   3. (Optional) Apply vlc.js wrapper patches if present
#   4. Run VLC's own wasm-emscripten build system
#   5. Generate symbol export list
#   6. Call create_main.sh for final emcc linking
#
# Adapted from: https://code.videolan.org/jbk/vlc.js/-/blob/incoming/compile.sh
# VLC WASM build docs: extras/package/wasm-emscripten/ in VLC source
#
# Environment variables:
#   SLOW_MODE  — Build mode (default: 1 = full from source, required first time)
#   EMSDK      — Path to Emscripten SDK (default: /opt/emsdk)
#   VLC_COMMIT — Override the VLC commit hash

set -e

# ---- Configuration ----

# VLC master commit hash — TESTED_HASH pattern from upstream vlc.js.
# This hash is known to build successfully with the current Emscripten version.
#
# 65e744b0 = 2026-01-29: latest wasm-emscripten build.sh change
#            (removed schroedinger, uses avcodec for Dirac)
#
# Previous hashes:
#   06e361b1 = 2022 (vlc.js incoming branch, Emscripten 3.1.18)
#   7bad2a86 = 2020 (vlc.js master branch, Emscripten tot-upstream)
#
# To upgrade: pick a newer commit from VLC master, update this hash.
# Check recent wasm-emscripten changes at:
#   https://code.videolan.org/videolan/vlc/-/commits/master/extras/package/wasm-emscripten
TESTED_HASH="${VLC_COMMIT:-65e744b0}"

SLOW_MODE="${SLOW_MODE:-1}"
WORK_DIR="${PWD}"
EMSDK_DIR="${EMSDK:-/opt/emsdk}"

# ---- Helper functions ----

diagnostic() {
    echo "$@" 1>&2
}

checkfail() {
    if [ ! $? -eq 0 ]; then
        diagnostic "$1"
        exit 1
    fi
}

# ---- Step 1: Activate Emscripten SDK ----

if [ ! -d "${EMSDK_DIR}" ]; then
    diagnostic "ERROR: Emscripten SDK not found at ${EMSDK_DIR}"
    diagnostic "When running outside Docker, install emsdk first:"
    diagnostic "  git clone https://github.com/emscripten-core/emsdk.git ${EMSDK_DIR}"
    diagnostic "  cd ${EMSDK_DIR} && ./emsdk install 4.0.1 && ./emsdk activate 4.0.1"
    exit 1
fi

diagnostic "Activating Emscripten SDK at ${EMSDK_DIR}"
# shellcheck disable=SC1091
. "${EMSDK_DIR}/emsdk_env.sh"

if ! command -v emcc &> /dev/null; then
    diagnostic "ERROR: emcc not found after activating emsdk."
    exit 1
fi
diagnostic "Using emcc version: $(emcc --version | head -1)"

# ---- Step 2: Clone VLC source ----

cd "${WORK_DIR}"

if [ ! -d vlc ]; then
    diagnostic "VLC source not found, cloning..."
    git clone https://code.videolan.org/videolan/vlc.git vlc
    checkfail "VLC source: git clone failed"

    cd vlc
    diagnostic "VLC source: resetting to TESTED_HASH (${TESTED_HASH})"
    git reset --hard "${TESTED_HASH}"
    checkfail "VLC source: TESTED_HASH ${TESTED_HASH} not found"

    # ---- Step 3: Apply vlc.js wrapper patches (if any) ----
    # VLC master now includes core WASM support (audio worklet, WebGL vout,
    # Emscripten threading). These patches are only needed for vlc.js-specific
    # wrapper integration that hasn't been upstreamed yet.
    #
    # If building against a recent VLC master commit, many or all patches
    # from vlc_patches/aug/ may already be merged. The build will warn if
    # patches fail to apply — this is expected for already-merged patches.
    if [ -d ../vlc_patches/aug ] && [ "$(ls -A ../vlc_patches/aug 2>/dev/null)" ]; then
        diagnostic "Attempting to apply vlc.js patches from vlc_patches/aug/..."
        for patch in ../vlc_patches/aug/*; do
            if git am -3 "$patch" 2>/dev/null; then
                diagnostic "  Applied: $(basename "$patch")"
            else
                diagnostic "  Skipped (already merged or conflict): $(basename "$patch")"
                git am --abort 2>/dev/null || true
            fi
        done
    else
        diagnostic "No vlc.js patches found — using VLC master as-is (expected for recent commits)"
    fi

    # ---- Step 3b: Inject WebCodec module sources (bypasses git am for VLC 4.0 compat) ----
    # The upstream webcodec patches fail git am against VLC 4.0 due to API drift.
    # Instead, we copy the ported source files directly and apply minimal header edits.
    if [ -d ../webcodec ]; then
        diagnostic "Injecting WebCodec sources into VLC tree..."

        cp ../webcodec/webcodec.cpp modules/codec/webcodec.cpp
        mkdir -p modules/video_output/emscripten
        cp ../webcodec/common.h modules/video_output/emscripten/common.h
        cp ../webcodec/interop_emscripten.cpp modules/video_output/opengl/interop_emscripten.cpp

        # vlc_codec.h: add VLC_DECODER_DEVICE_WEBCODEC after VLC_DECODER_DEVICE_MMAL
        sed -i 's/VLC_DECODER_DEVICE_MMAL,/VLC_DECODER_DEVICE_MMAL,\n    VLC_DECODER_DEVICE_WEBCODEC,/' include/vlc_codec.h
        if ! grep -q 'VLC_DECODER_DEVICE_WEBCODEC' include/vlc_codec.h; then
            diagnostic "ERROR: sed failed to inject VLC_DECODER_DEVICE_WEBCODEC into vlc_codec.h — pattern 'VLC_DECODER_DEVICE_MMAL,' not found"
            exit 1
        fi

        # vlc_picture.h: add VLC_VIDEO_CONTEXT_WEBCODEC after VLC_VIDEO_CONTEXT_MMAL
        sed -i 's/VLC_VIDEO_CONTEXT_MMAL,/VLC_VIDEO_CONTEXT_MMAL,\n    VLC_VIDEO_CONTEXT_WEBCODEC,/' include/vlc_picture.h
        if ! grep -q 'VLC_VIDEO_CONTEXT_WEBCODEC' include/vlc_picture.h; then
            diagnostic "ERROR: sed failed to inject VLC_VIDEO_CONTEXT_WEBCODEC into vlc_picture.h — pattern 'VLC_VIDEO_CONTEXT_MMAL,' not found"
            exit 1
        fi

        # vlc_fourcc.h: add VLC_CODEC_WEBCODEC_OPAQUE after VLC_CODEC_CVPX_P010
        sed -i "/VLC_CODEC_CVPX_P010/a #define VLC_CODEC_WEBCODEC_OPAQUE VLC_FOURCC('W','C','O','P')" include/vlc_fourcc.h
        if ! grep -q 'VLC_CODEC_WEBCODEC_OPAQUE' include/vlc_fourcc.h; then
            diagnostic "ERROR: sed failed to inject VLC_CODEC_WEBCODEC_OPAQUE into vlc_fourcc.h — pattern 'VLC_CODEC_CVPX_P010' not found"
            exit 1
        fi

        # fourcc.c: add GPU_FMT(OTHER,0) entry after CVPX_P010
        sed -i '/VLC_CODEC_CVPX_P010.*GPU_FMT/a\    { VLC_CODEC_WEBCODEC_OPAQUE,        GPU_FMT(OTHER, 0) },' src/misc/fourcc.c
        if ! grep -q 'VLC_CODEC_WEBCODEC_OPAQUE' src/misc/fourcc.c; then
            diagnostic "ERROR: sed failed to inject VLC_CODEC_WEBCODEC_OPAQUE into fourcc.c — pattern 'VLC_CODEC_CVPX_P010.*GPU_FMT' not found"
            exit 1
        fi

        # modules/codec/Makefile.am: register webcodec plugin
        printf '\nlibwebcodec_plugin_la_SOURCES = codec/webcodec.cpp\n'       >> modules/codec/Makefile.am
        printf 'libwebcodec_plugin_la_CXXFLAGS = $(AM_CXXFLAGS) -std=c++20\n'  >> modules/codec/Makefile.am
        printf 'libwebcodec_plugin_la_LDFLAGS = $(AM_LDFLAGS) -s ASYNCIFY=1\n' >> modules/codec/Makefile.am
        printf 'if HAVE_EMSCRIPTEN\ncodec_LTLIBRARIES += libwebcodec_plugin.la\nendif\n' >> modules/codec/Makefile.am

        # modules/video_output/Makefile.am: register glinterop_emscripten plugin
        printf '\n### Emscripten WebCodec interop\n'                          >> modules/video_output/Makefile.am
        printf 'libglinterop_emscripten_plugin_la_SOURCES = video_output/opengl/interop_emscripten.cpp video_output/opengl/interop.h\n' >> modules/video_output/Makefile.am
        printf 'libglinterop_emscripten_plugin_la_CXXFLAGS = $(AM_CXXFLAGS) -std=c++20 -DUSE_OPENGL_ES2\n' >> modules/video_output/Makefile.am
        printf 'libglinterop_emscripten_plugin_la_LDFLAGS = $(AM_LDFLAGS) -s ASYNCIFY=1\n' >> modules/video_output/Makefile.am
        printf 'if HAVE_EMSCRIPTEN\nvout_LTLIBRARIES += libglinterop_emscripten_plugin.la\nendif\n' >> modules/video_output/Makefile.am

        diagnostic "  webcodec.cpp, interop_emscripten.cpp, common.h injected"
        diagnostic "  Header edits applied (vlc_codec.h, vlc_picture.h, vlc_fourcc.h, fourcc.c)"
        diagnostic "  Makefile.am entries added"
    else
        diagnostic "No webcodec/ directory found — skipping WebCodec injection"
    fi

    cd "${WORK_DIR}"
else
    diagnostic "VLC source directory already exists, skipping clone"
fi

# ---- Step 4: Build VLC for WebAssembly ----
# Uses VLC's built-in wasm-emscripten build system.
# This compiles all contribs (FFmpeg, etc.) and VLC core + modules.
#
# VLC's build.sh enables:
#   --enable-avcodec --enable-avformat --enable-swscale --enable-postproc
#   --enable-gles2 --enable-vpx
# And disables everything not needed for browser playback.

diagnostic "Building VLC for WebAssembly (SLOW_MODE=${SLOW_MODE})..."
diagnostic "Using VLC's built-in extras/package/wasm-emscripten/build.sh"
cd ./vlc/extras/package/wasm-emscripten/
./build.sh --mode="${SLOW_MODE}"
cd "${WORK_DIR}"

# ---- Step 5: Generate symbol export list ----

diagnostic "Generating symbol export list..."
echo "_main" > libvlc_wasm.sym
# _malloc and _free are required by the JS wrapper (main.js, lib/libvlc.js)
# Emscripten 4.0.1+ does not export them by default
echo "_malloc" >> libvlc_wasm.sym
echo "_free" >> libvlc_wasm.sym
sed -e 's/^/_/' ./vlc/lib/libvlc.sym >> libvlc_wasm.sym

# ---- Step 6: Final link step ----

diagnostic "Linking final WebAssembly executable..."
cd "${WORK_DIR}"
./create_main.sh

diagnostic ""
diagnostic "Build complete! Output files:"
ls -lh experimental.js experimental.wasm 2>/dev/null
ls -lh experimental.worker.js 2>/dev/null || true
