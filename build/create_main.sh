#!/bin/bash
# create_main.sh — Final emcc linking step for VLC.js
#
# This script takes all the compiled VLC libraries and modules and links them
# into the final WebAssembly output: experimental.js + experimental.wasm +
# experimental.worker.js
#
# Adapted from: https://code.videolan.org/jbk/vlc.js/-/blob/incoming/create_main.sh
#
# Prerequisites:
#   - Emscripten SDK activated (emsdk_env.sh sourced)
#   - VLC built for wasm-emscripten (compile.sh completed steps 1-5)
#   - libvlc_wasm.sym generated (compile.sh step 5)
#
# Environment variables:
#   PATH_VLC   — Path to VLC source directory (default: ./vlc)
#   SAMPLE_DIR — Path to sample media files for preloading (default: ./samples)

set -e

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

# Activate Emscripten SDK if not already active
if [ -z "${EMSDK}" ]; then
    if [ -d /opt/emsdk ]; then
        # shellcheck disable=SC1091
        . /opt/emsdk/emsdk_env.sh
    elif [ -d ./emsdk ]; then
        # shellcheck disable=SC1091
        . ./emsdk/emsdk_env.sh
    else
        diagnostic "ERROR: Emscripten SDK not found. Source emsdk_env.sh first."
        exit 1
    fi
fi

# Verify emcc is available
if ! command -v emcc &> /dev/null; then
    diagnostic "ERROR: emcc not found. Activate emsdk first."
    exit 1
fi

if [ ! -d vlc ]; then
    diagnostic "ERROR: vlc directory not found. Run compile.sh first."
    exit 1
fi

PATH_VLC="${PATH_VLC:-./vlc}"
SAMPLE_DIR="${SAMPLE_DIR:-./samples}"

diagnostic "Linking VLC WebAssembly module..."
diagnostic "  VLC path: ${PATH_VLC}"
diagnostic "  emcc: $(which emcc)"

# Locate the webaudio.js library (path varies between VLC versions)
WEBAUDIO_JS=$(find "${PATH_VLC}" -name "webaudio.js" -path "*/audio_output/*" 2>/dev/null | head -1)
if [ -z "${WEBAUDIO_JS}" ] && [ -f "js-libs/webaudio.js" ]; then
    WEBAUDIO_JS="js-libs/webaudio.js"
fi
if [ -z "${WEBAUDIO_JS}" ] && [ -f "vlcjs-upstream/lib/webaudio.js" ]; then
    WEBAUDIO_JS="vlcjs-upstream/lib/webaudio.js"
fi
if [ -n "${WEBAUDIO_JS}" ]; then
    WEBAUDIO_LIB="--js-library ${WEBAUDIO_JS}"
    diagnostic "  webaudio.js: ${WEBAUDIO_JS}"
else
    WEBAUDIO_LIB=""
    diagnostic "  WARNING: webaudio.js not found — audio output may not work"
fi

# ---- emcc flags explained ----
#
# --bind                    Enable Embind for C++/JS interop
# -s USE_PTHREADS=1         Enable POSIX threads (required for VLC's threading)
# -s TOTAL_MEMORY=2GB       Initial WebAssembly memory allocation (VLC needs a lot)
# -s PTHREAD_POOL_SIZE=25   Pre-create 25 Web Workers for pthread emulation
# -s OFFSCREEN_FRAMEBUFFER=1  Enable offscreen framebuffer for WebGL rendering
# -s USE_WEBGL2=1           Enable WebGL 2.0 support
# --profiling-funcs         Keep function names in output (for debugging)
#                           Remove for release builds and add -Os instead
# -s OFFSCREENCANVAS_SUPPORT=1  Enable OffscreenCanvas for worker rendering
# -s MODULARIZE=1           Wrap output in a module factory function
# -s EXPORT_NAME="initModule"  Name of the module factory function
# -s EXPORTED_RUNTIME_METHODS  JS runtime helpers to export
# -s ASYNCIFY=1             Enable async/await support (for blocking C calls)
# -O3                       Maximum optimization level
# -s EXIT_RUNTIME=1         Clean up runtime on exit
# -s ASSERTIONS=1           Enable runtime assertions (remove for release)
# -s EXPORTED_FUNCTIONS=@file  Read exported function names from file
# --js-library              Include custom JS library files
# -o experimental.js        Output filename (also creates .wasm and .worker.js)

emcc --bind \
    -Wl,--allow-multiple-definition \
    -s USE_PTHREADS=1 \
    -s TOTAL_MEMORY=2GB \
    -s ALLOW_MEMORY_GROWTH \
    -s PTHREAD_POOL_SIZE=25 \
    -s OFFSCREEN_FRAMEBUFFER=1 \
    -s USE_WEBGL2=1 \
    --profiling-funcs \
    -s OFFSCREENCANVAS_SUPPORT=1 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="initModule" \
    -s EXPORTED_RUNTIME_METHODS="[allocateUTF8, writeAsciiToMemory, wasmMemory, PThread]" \
    -s ASYNCIFY=1 \
    -O3 \
    -s EXIT_RUNTIME=1 \
    -s ASSERTIONS=1 \
    -I "${PATH_VLC}/include/" \
    src/main.c src/exports_media_player.c src/exports_media.c \
    -s EXPORTED_FUNCTIONS=@libvlc_wasm.sym \
    "${PATH_VLC}/build-emscripten/lib/.libs/libvlc.a" \
    "${PATH_VLC}/build-emscripten/vlc-modules.bc" \
    "${PATH_VLC}/build-emscripten/modules/.libs/"*.a \
    "${PATH_VLC}/contrib/wasm32-unknown-emscripten/lib/"*.a \
    "${PATH_VLC}/build-emscripten/src/.libs/libvlccore.a" \
    "${PATH_VLC}/build-emscripten/compat/.libs/libcompat.a" \
    --js-library js-libs/wasm-imports.js \
    ${WEBAUDIO_LIB} \
    -o experimental.js

checkfail "emcc linking failed"

diagnostic ""
diagnostic "Link complete. Output files:"
ls -lh experimental.js experimental.wasm 2>/dev/null
# experimental.worker.js may or may not be generated depending on Emscripten version
# In 4.0.1+, the worker code may be embedded in experimental.js
ls -lh experimental.worker.js 2>/dev/null || diagnostic "  (experimental.worker.js not generated — worker code may be embedded in experimental.js)"
