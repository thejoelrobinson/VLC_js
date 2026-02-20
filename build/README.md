# VLC.js WebAssembly Build Pipeline

This directory contains a Dockerized build pipeline for compiling VLC media player
to WebAssembly using Emscripten. The output replaces the `experimental.*` files
in the project root.

## Key Change: VLC Master Has Built-in WASM Support

As of 2024, VLC's `master` branch includes native WebAssembly/Emscripten build
support at `extras/package/wasm-emscripten/build.sh`. This means:

- **No external patches needed** for core VLC WASM compilation
- Audio worklet output, WebGL video output, and Emscripten threading are upstream
- VLC's CI actively builds WASM targets with Emscripten 4.0.1
- The old vlc.js approach (20+ patches against a 2022 commit) is obsolete

The only patches still potentially needed are vlc.js-specific wrapper integration
(the `exports_media_player.c`, `exports_media.c`, and `main.c` bridge files).

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
2. Clone VLC master at the pinned commit (`65e744b0`)
3. Run VLC's built-in `extras/package/wasm-emscripten/build.sh`
4. Link the final `experimental.js` + `.wasm` + `.worker.js`
5. Copy the output files to the project root

The first build will be slow (compiling VLC + FFmpeg + all contribs from source).
Subsequent builds use Docker layer caching.

## Output Files

| File | Description |
|---|---|
| `experimental.js` | Emscripten-generated JS glue code (~400 KB) |
| `experimental.wasm` | Compiled VLC + FFmpeg WASM binary (~26 MB) |
| `experimental.worker.js` | Web Worker bootstrap for pthread emulation |

## Version Pins

### Emscripten SDK

**Current: 4.0.1** (matches VLC's official CI)

Pinned in:
- `Dockerfile` — `ARG EMSDK_VERSION=4.0.1`
- `docker-compose.yml` — `EMSDK_VERSION: "4.0.1"`

### VLC Source (TESTED_HASH)

**Current: `65e744b0`** (2026-01-29, VLC master)

This is the commit hash from VLC's main repository that the build is tested
against. The `TESTED_HASH` pattern was introduced by Mehdi Sabwat in
[commit 58a76be8](https://code.videolan.org/jbk/vlc.js/-/commit/58a76be8b4e9dd4012e7e70561e1b87146e95e43)
to manage reproducible VLC version pinning.

| Hash | Date | Notes |
|---|---|---|
| `65e744b0` | 2026-01-29 | **Current** — latest wasm build.sh change, VPX codecs |
| `fb211a15` | 2025-11-11 | CI Docker image update |
| `f6ebf56c` | 2025-02-14 | CI updated to Emscripten 4.0.1 |
| `707f6f6b` | 2025-01-23 | VPX codec enabled for WASM |
| `06e361b1` | 2022 | Old vlc.js incoming branch target (required 20+ patches) |
| `7bad2a86` | 2020 | Original vlc.js master branch target |

### What VLC Master WASM Build Enables

VLC's `extras/package/wasm-emscripten/build.sh` configures these codecs:
- `--enable-avcodec` — FFmpeg libavcodec (H.264, H.265, VP8, VP9, AAC, MP3, etc.)
- `--enable-avformat` — FFmpeg container demuxing (MKV, MP4, MXF, etc.)
- `--enable-swscale` — Image/video scaling
- `--enable-postproc` — Post-processing filters
- `--enable-gles2` — WebGL ES 2.0 video output
- `--enable-vpx` — VP8/VP9 codecs (added Jan 2025)

## How to Upgrade VLC

1. Find the desired commit hash from https://code.videolan.org/videolan/vlc/-/commits/master

   Filter for `extras/package/wasm-emscripten` to find WASM-relevant changes.

2. Update in both files:
   ```
   Dockerfile:         ARG VLC_TESTED_HASH=<new-hash>
   docker-compose.yml: VLC_TESTED_HASH: "<new-hash>"
   compile.sh:         TESTED_HASH="${VLC_COMMIT:-<new-hash>}"
   ```

3. Rebuild:
   ```bash
   docker compose build --no-cache
   docker compose up
   ```

4. Since VLC master has built-in WASM support, patches should rarely be needed.
   If the build fails, check the Emscripten version compatibility first.

## How to Upgrade Emscripten

1. Check the [changelog](https://github.com/emscripten-core/emscripten/blob/main/ChangeLog.md)

2. Update in both files:
   ```
   Dockerfile:         ARG EMSDK_VERSION=<new-version>
   docker-compose.yml: EMSDK_VERSION: "<new-version>"
   ```

3. Rebuild from scratch:
   ```bash
   docker compose build --no-cache
   docker compose up
   ```

Breaking changes from 3.1.18 → 4.0.1:
- LLVM upgraded from 15 to 20
- `EXTRA_EXPORTED_RUNTIME_METHODS` renamed to `EXPORTED_RUNTIME_METHODS`
- `-emit-llvm` required for bitcode (since 3.1.50)
- `reference-types` enabled by default
- musl libc updated from 1.1.x to 1.2.x

## emcc Linking Flags Reference

These flags are used in `create_main.sh` for the final link step:

| Flag | Purpose |
|---|---|
| `--bind` | Enable Embind for C++/JS interoperability |
| `-s USE_PTHREADS=1` | Enable POSIX thread emulation via Web Workers |
| `-s TOTAL_MEMORY=2GB` | Initial WASM memory (VLC needs significant memory) |
| `-s PTHREAD_POOL_SIZE=25` | Pre-spawn 25 Web Workers for pthreads |
| `-s OFFSCREEN_FRAMEBUFFER=1` | Enable offscreen framebuffer for worker WebGL |
| `-s USE_WEBGL2=1` | Enable WebGL 2.0 for video rendering |
| `-s MODULARIZE=1` | Wrap output in a factory function |
| `-s EXPORT_NAME="initModule"` | Factory function name |
| `-s ASYNCIFY=1` | Async/await for blocking C calls |
| `-O3` | Maximum optimization |

## Troubleshooting

### Build fails at VLC configure step
Check Emscripten version matches what VLC's CI uses. Run `emcc --version` inside
the Docker container and compare with VLC's `.gitlab-ci.yml`.

### Out of memory during build
Ensure Docker has at least 4 GB RAM. On Docker Desktop: Settings > Resources > Memory.

### Canon MXF / 10-bit H.264 4:2:2 not decoding
FFmpeg's H.264 decoder supports all profiles including High 4:2:2 10-bit, but
4K software decoding in WASM is very CPU-intensive. The `--codec=webcodec` option
tries the browser's hardware decoder first — if the browser doesn't support
High 4:2:2, it falls back to software, which may be too slow at 4K.

### SharedArrayBuffer not available
Requires `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` headers. The project's `server.js`
already serves these.
