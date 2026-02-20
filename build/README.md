# VLC.js WebAssembly Build Pipeline

This directory contains a Dockerized build pipeline for compiling VLC media player
to WebAssembly using Emscripten. The output replaces the `experimental.*` files
in the project root.

## Prerequisites

- **Docker** (20.10+) and **Docker Compose** (v2+)
- ~10 GB free disk space (VLC source + contribs + build artifacts)
- Stable internet connection (clones VLC repo + Emscripten SDK)

No other tools are required on the host machine — everything runs inside Docker.

## Quick Start

From the `build/` directory:

```bash
docker compose up
```

This will:
1. Build a Docker image with Emscripten SDK 4.0.1
2. Clone VLC source at the pinned commit
3. Apply all patches from `vlc_patches/aug/`
4. Compile VLC and all dependencies for WebAssembly
5. Link the final `experimental.js` + `.wasm` + `.worker.js`
6. Copy the output files to the project root

The first build will be slow (compiling VLC + FFmpeg + all contribs from source).
Subsequent builds use Docker layer caching.

## Alternative: Manual Docker Build

```bash
cd build/
docker build -t vlcjs-builder .
docker run --rm -v "$(pwd)/..":/host-output vlcjs-builder
```

## Output Files

| File | Description |
|---|---|
| `experimental.js` | Emscripten-generated JS glue code (~400 KB) |
| `experimental.wasm` | Compiled VLC + FFmpeg WASM binary (~26 MB) |
| `experimental.worker.js` | Web Worker bootstrap for pthread emulation |

These files are consumed by `lib/module-loader.js` at runtime.

## Version Pins

### Emscripten SDK

**Current version: 4.0.1**

The Emscripten version is pinned in two places:
- `Dockerfile` — `ARG EMSDK_VERSION=4.0.1`
- `docker-compose.yml` — `EMSDK_VERSION: "4.0.1"`

The upstream vlc.js (2022) used Emscripten 3.1.18. The current upstream VideoLAN
Docker image uses 4.0.1. Major breaking changes between 3.1.18 and 4.0.1:

- LLVM upgraded from 15 to 20
- `EXTRA_EXPORTED_RUNTIME_METHODS` renamed to `EXPORTED_RUNTIME_METHODS`
- `EM_BOOL` type changed from `int` to `bool`
- pthread `.worker.js` generation changed
- `reference-types` enabled by default
- `time_t` restored to 64-bit
- musl libc updated from 1.1.x to 1.2.x

### VLC Source

**Current commit: `06e361b127e4609e429909756212ed5e30e7d032`**

This is the VLC commit that the patches are tested against. It is from the VLC
master branch (pre-4.0). VLC 4.0 is still under active development (milestone
targets July 2026) with nightly builds available.

## How to Upgrade Emscripten

1. Check the [Emscripten changelog](https://github.com/emscripten-core/emscripten/blob/main/ChangeLog.md) for breaking changes.

2. Update the version in both files:
   ```
   Dockerfile:         ARG EMSDK_VERSION=<new-version>
   docker-compose.yml: EMSDK_VERSION: "<new-version>"
   ```

3. Rebuild from scratch:
   ```bash
   docker compose build --no-cache
   docker compose up
   ```

4. Test the output by running the VLC.js player in a browser.

5. Common issues after Emscripten upgrades:
   - Renamed `-s` flags (check deprecation warnings in build output)
   - Changed default behaviors (e.g., `reference-types`, `MEMORY64`)
   - ABI changes in emulated POSIX APIs
   - Updated LLVM may reject previously-accepted code

## How to Upgrade VLC

1. Find the desired commit hash from https://code.videolan.org/videolan/vlc

2. Update the hash in both files:
   ```
   Dockerfile:         ARG VLC_COMMIT_HASH=<new-hash>
   docker-compose.yml: VLC_COMMIT_HASH: "<new-hash>"
   ```

3. Test that all patches apply cleanly:
   ```bash
   docker compose build --no-cache 2>&1 | grep -A2 "Applying"
   ```

4. If patches fail to apply:
   - Clone VLC locally at the new commit
   - Rebase each patch in `vlc_patches/aug/` onto the new commit
   - Use `git format-patch` to regenerate the patch files
   - Update this directory with the new patches

## Patch Descriptions

The patches in `vlc_patches/aug/` modify VLC to build and run under Emscripten:

| Patch | Purpose |
|---|---|
| 0001 | Fix configure GL function tests for Emscripten |
| 0002 | Disable libvlc_json and ytbdl modules (not needed in WASM) |
| 0003-0006 | Add wasm-emscripten support to contribs (libass, gcrypt, gmp, gnutls) |
| 0007-0013 | Emscripten audio worklet output module (WebAudio API) |
| 0014-0016 | Emscripten WebGL video output module |
| 0017 | Allow C OpenGL modules in vout |
| 0018 | Start vout from vout thread (Emscripten threading constraint) |
| 0019 | Forcefully disable `accept4()` (unavailable in Emscripten) |
| 0020 | Convert emscripten vout module from C++ to C |

## emcc Linking Flags Reference

These flags are used in `create_main.sh` for the final link step:

| Flag | Purpose |
|---|---|
| `--bind` | Enable Embind for C++/JS interoperability |
| `-s USE_PTHREADS=1` | Enable POSIX thread emulation via Web Workers |
| `-s TOTAL_MEMORY=2GB` | Initial WASM linear memory size (VLC needs significant memory) |
| `-s PTHREAD_POOL_SIZE=25` | Pre-spawn 25 Web Workers for pthread emulation |
| `-s OFFSCREEN_FRAMEBUFFER=1` | Enable offscreen framebuffer for worker-side WebGL |
| `-s USE_WEBGL2=1` | Enable WebGL 2.0 support for video rendering |
| `-s OFFSCREENCANVAS_SUPPORT=1` | Enable OffscreenCanvas API for rendering in workers |
| `-s MODULARIZE=1` | Wrap output in a factory function (not a global) |
| `-s EXPORT_NAME="initModule"` | Name of the factory function called to instantiate |
| `-s EXPORTED_RUNTIME_METHODS=[...]` | JS runtime helpers exposed to user code |
| `-s ASYNCIFY=1` | Transform synchronous C code to async JS (for blocking calls) |
| `-O3` | Maximum optimization (size + speed) |
| `-s EXIT_RUNTIME=1` | Clean up WASM runtime on program exit |
| `-s ASSERTIONS=1` | Runtime assertion checks (remove for production) |
| `--profiling-funcs` | Keep function names for debugging (remove for production) |
| `--js-library` | Include custom JavaScript library implementations |
| `-s EXPORTED_FUNCTIONS=@file` | Read list of C functions to export from a file |

### Production Build

For a smaller, faster production build, modify `create_main.sh`:
- Remove `--profiling-funcs`
- Remove `-s ASSERTIONS=1`
- Optionally change `-O3` to `-Os` for smaller WASM size

## Known Issues and Troubleshooting

### Build fails at patch step
The patches are tightly coupled to the pinned VLC commit. If you change the
VLC commit hash, you may need to rebase patches. See "How to Upgrade VLC" above.

### Out of memory during build
The VLC build compiles many libraries (FFmpeg, gnutls, etc.) which is memory
intensive. Ensure Docker has at least 4 GB of memory allocated. On Docker
Desktop, go to Settings > Resources > Memory.

### Build takes very long
The first build compiles all VLC contrib libraries from source for the
`wasm32-unknown-emscripten` target. This is expected. Subsequent builds
use Docker layer caching unless you change the VLC commit or Emscripten version.

### emcc: error: undefined symbol
This usually means a VLC module references a system function not available
in Emscripten. Check if a patch is needed to disable the offending module
or stub out the missing function.

### SharedArrayBuffer not available in browser
The output requires `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` HTTP headers. The project's
`server.js` already serves these headers.

### Firefox compatibility
Firefox requires `dom.postMessage.sharedArrayBuffer.bypassCOOP_COEP.insecure.enabled`
in `about:config` for SharedArrayBuffer to work properly with the COOP/COEP
headers.

## Architecture

```
Docker Build Pipeline:
  Dockerfile Stage 1 (toolchain)
    └── Debian bookworm-slim
    └── System build deps (autotools, cmake, etc.)
    └── Emscripten SDK (pinned version)

  Dockerfile Stage 2 (builder)
    └── compile.sh
        ├── Clone VLC at pinned commit
        ├── Apply vlc_patches/aug/*.patch
        ├── Run VLC wasm-emscripten build system
        │   ├── Bootstrap contribs (FFmpeg, gnutls, etc.)
        │   └── Configure + make VLC core + modules
        ├── Generate symbol export list
        └── create_main.sh (final emcc link)
            └── Output: experimental.{js,wasm,worker.js}

  Dockerfile Stage 3 (output)
    └── Minimal image with just the 3 output files
```
