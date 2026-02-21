# VLC.js — WebAssembly VLC Media Player

## Project Overview

VLC.js is VLC media player compiled to WebAssembly via Emscripten. It plays video/audio files entirely in the browser using a 31 MB WASM binary containing VLC core + FFmpeg codecs + the webcodec plugin.

**Upstream source:** https://code.videolan.org/jbk/vlc.js/ (use `incoming` branch, not `master`)
**Status:** Upstream is unmaintained (last commit Oct 2022). This fork has been substantially modernized: VLC upgraded to 4.0 master, Emscripten upgraded to 4.0.1, WebCodecs H.264/MXF playback implemented, full test suite added, Dockerized build pipeline.

**Current build:** VLC 4.0 master + Emscripten 4.0.1, webcodec plugin compiled in, all 87 tests passing.

## Architecture

```
Browser UI (vlc.html, vlc.css)
    ↓
main.js — app entry point, event wiring, VLC option management
    ↓
JS Wrapper Layer (lib/libvlc.js, lib/overlay.js, lib/module-loader.js)
    ↓
Emscripten Glue (experimental.js) — generated, do not hand-edit
    ↓
WASM Binary (experimental.wasm) — compiled VLC 4.0 + FFmpeg + webcodec plugin, 31 MB
    ↓
Web Workers (experimental.worker.js) — POSIX thread emulation via pthreads
    ↓
Audio Output (audio-worklet-processor.js) — Web Audio API AudioWorklet (SAB/Atomics protocol)
    ↓ (WebCodecs path only)
Browser VideoDecoder API — hardware-accelerated H.264/HEVC decode
```

### WebCodecs Rendering Path

For H.264/MXF files, frames bypass VLC's GL rendering pipeline entirely:

1. VLC's webcodec C++ plugin calls `VideoDecoder.decode()` via EM_ASYNC_JS
2. Decoded `VideoFrame` objects are delivered via `window.vlcOnDecoderFrame()` callback (Emscripten callHandler)
3. `module-loader.js` intercepts frames and draws them directly to the canvas via `ctx.drawImage(frame)` (2D context)
4. VLC's glinterop plugin is NOT used for WebCodecs — `VLC_CODEC_WEBCODEC_OPAQUE` frames are handled in JS

## Key Files

| File | Editable? | Purpose |
|---|---|---|
| `main.js` | YES | App entry point — event wiring, VLC option management, file input; extracted from inline `vlc.html` scripts |
| `lib/libvlc.js` | YES | `MediaPlayer` and `Media` classes wrapping WASM function calls |
| `lib/overlay.js` | YES | UI controls: play/pause, progress bar, volume, chapters |
| `lib/module-loader.js` | YES | Emscripten module init + VideoDecoder patching (bare `avc1` → `avc1.640028`) + direct canvas rendering for WebCodecs frames |
| `vlc.html` | YES | Main page — canvas, file picker; scripts extracted to `main.js` (114 lines, down from 352) |
| `vlc.css` | YES | Styling — now responsive with dark mode support (was hardcoded 1280x720) |
| `audio-worklet-processor.js` | YES | AudioWorklet using SAB + Atomics protocol to receive PCM from WASM |
| `server.js` | YES | Dev server — COOP/COEP headers, path traversal protection |
| `build/compile.sh` | YES | Docker build script — clones VLC master, applies patches, injects webcodec plugin, links with Emscripten 4.0.1 |
| `build/Dockerfile` | YES | Docker image for reproducible WASM builds |
| `build/webcodec/` | YES | webcodec VLC plugin source: `webcodec.cpp`, `interop_emscripten.cpp`, `common.h` |
| `build/vlc_patches/` | YES | Patch series applied to VLC source before build |
| `tests/` | YES (add only) | Vitest unit tests — libvlc, server, HTML structure, MXF playback |
| `vitest.config.js` | YES | Vitest configuration |
| `experimental.js` | NO | Emscripten-generated glue code (~364 KB) — VLC 4.0 + Emscripten 4.0.1 |
| `experimental.wasm` | NO | Compiled binary (31 MB) — VLC 4.0 + webcodec plugin; requires Docker rebuild to change |
| `experimental.worker.js` | NO | Emscripten-generated worker bootstrap |

## WASM Function Interface

The JS layer calls WASM via `module._wasm_*()` functions. Key exports:

- `_wasm_libvlc_init(argc, argv)` — initialize VLC with options
- `_wasm_media_player_new()` → pointer
- `_wasm_media_player_play/pause/stop(ptr)`
- `_wasm_media_player_get_time/set_time(ptr, ms)`
- `_wasm_media_player_get_position/set_position(ptr, float)`
- `_wasm_media_new_location(path_ptr)` → pointer
- `_wasm_audio_get_volume/set_volume(ptr, int)`
- `_wasm_audio_toggle_mute(ptr)`
- `_set_global_media_player(ptr)`
- `_attach_update_events(ptr)`

Emscripten helpers used: `allocateUTF8()`, `_free()`, `_malloc()`, `writeAsciiToMemory()`, `wasmMemory`.

## Browser Requirements

- SharedArrayBuffer (requires COOP/COEP headers — server.js provides these)
- WebGL2
- AudioWorklet
- ES Modules
- WASM with threads (pthreads)
- Chrome/Edge recommended. Firefox needs `dom.postMessage.sharedArrayBuffer.bypassCOOP_COEP.insecure.enabled`.

## Development

```bash
npm start              # Start dev server at http://localhost:3000
npm test               # Run unit tests (Vitest) — 87 tests across 5 files
npm run test:watch     # Run tests in watch mode
npm run test:browser   # Run MXF browser playback tests (requires running server)
```

**Default VLC options** (stored in `localStorage`, editable in the UI):
```
--codec=webcodec --aout=emworklet --avcodec-threads=1
```
- `--codec=webcodec` — use browser VideoDecoder for H.264/HEVC
- `--aout=emworklet` — enable audio via AudioWorklet (was `adummy` in original)
- `--avcodec-threads=1` — prevents `thread_get_buffer()` failures when falling back to FFmpeg

## Git Workflow

- `main` — current working branch; `dev/js-updates` has been fully merged in. Contains all modernization work including WebCodecs.
- `dev/js-updates` — merged into `main` (commit `9c2222d`). No longer active.
- `dev/wasm-rebuild` — for future WASM binary rebuild experiments.
- Tag `v1.0-working` — permanent reference to the original 2020/2024 distribution state (`ed4128f`).

The "never commit directly to main" rule from the original CLAUDE.md no longer applies — `dev/js-updates` has been merged and `main` is the active branch.

## WASM Build (Docker)

**Current build:** `build/Dockerfile` + `build/compile.sh`
- **Emscripten SDK 4.0.1**
- **VLC master** (not the upstream 2022-era `incoming` branch)
- Build: `docker compose -f build/docker-compose.yml up` → clones VLC master, applies `build/vlc_patches/aug/` patch series, copies `build/webcodec/` plugin source, links with `emcc`
- Output: `experimental.js` (~364 KB), `experimental.wasm` (31 MB), `experimental.worker.js`

Key Emscripten flags in the link step:
```
-s USE_PTHREADS=1
-s ALLOW_MEMORY_GROWTH=1        # NEW — required for 4K video
-s TOTAL_MEMORY=2GB
-s PTHREAD_POOL_SIZE=25
-s OFFSCREEN_FRAMEBUFFER=1
-s USE_WEBGL2=1
-s MODULARIZE=1
-s EXPORT_NAME="initModule"
-s ASYNCIFY=1
-s EXPORTED_RUNTIME_METHODS=[...,wasmMemory,PThread]   # NEW — required by JS layer
-s EXPORTED_FUNCTIONS=[...,_malloc,_free]              # NEW — required by JS layer
-O3
```

The webcodec plugin Makefile.am must include `-s ASYNCIFY=1` in `libwebcodec_plugin_la_LDFLAGS` — without it, the `EM_ASYNC_JS` calls in `webcodec.cpp` and `interop_emscripten.cpp` fail silently.

**Upstream build (archived):** The original upstream used Emscripten 3.1.18 + Docker image `registry.videolan.org/vlc-debian-wasm-emscripten:20220505193036`. No longer used.

## Known Bugs — Status

All four original bugs are **fixed** (merged to `main`):

1. `lib/libvlc.js:239` — ~~template literal missing `$`~~ — **FIXED**
2. `lib/module-loader.js:10,13` — ~~duplicate `var was_clicked`~~ — **FIXED** (entire file rewritten as ES module)
3. `server.js:21` — ~~no path traversal protection~~ — **FIXED** (resolves path, checks `startsWith(ROOT)`)
4. `vlc.html:45` — ~~inline `oncontextmenu`~~ — **FIXED** (moved to `addEventListener` in `main.js`)

## Changes from v1.0 (`ed4128f` / tag `v1.0-working`)

Summary of every significant change made after the initial commit:

| Area | Change |
|---|---|
| **WASM binary** | Rebuilt from VLC 4.0 master + Emscripten 4.0.1 (was: VLC 3.x, Emscripten 3.1.18). Size: 27 MB → 31 MB. |
| **webcodec plugin** | Compiled into WASM. New files: `build/webcodec/{webcodec.cpp,interop_emscripten.cpp,common.h}`. |
| **`main.js`** | New file. All inline `<script>` logic from `vlc.html` extracted here. ES module. |
| **`vlc.html`** | Stripped from 352 → 114 lines. Inline scripts removed. ARIA attributes added. |
| **`vlc.css`** | Responsive layout + dark mode. Removed hardcoded 1280×720. |
| **`lib/module-loader.js`** | Fully rewritten (75 → 186 lines). Adds: VideoDecoder polyfill for bare `avc1`, direct canvas rendering for WebCodecs frames, proper ES module exports. |
| **`lib/libvlc.js`** | Template literal bug fixed. VLC 4.0 BigInt return values handled. |
| **`lib/overlay.js`** | Minor fixes; ARIA improvements. |
| **`audio-worklet-processor.js`** | Rewritten to use SAB + Atomics protocol matching VLC's C++ audio module (was: broken `type:'audio'` message protocol). |
| **`server.js`** | Path traversal protection added. Serves `main.js` and new asset types. |
| **`package.json`** | Added `vitest`, `jsdom`, `playwright-core` devDependencies. Added `test`, `test:watch`, `test:browser` scripts. Node requirement: 14 → 18. |
| **`build/`** | New directory: `Dockerfile`, `compile.sh`, `docker-compose.yml`, `patch_vlcjs_wrappers.sh`, `create_main.sh`, 80+ VLC patch files. |
| **`tests/`** | New directory: 5 test files, 87 tests (libvlc, server, html-structure, mxf-playback, mxf-browser-playback). |
| **`vitest.config.js`** | New file. |
| **`.github/workflows/test.yml`** | New CI pipeline running `npm test` on push. |
| **`experimental.js`** | Regenerated for VLC 4.0 / Emscripten 4.0.1. `wasmMemory`, `PThread`, `_malloc`, `_free` now exported. `ALLOW_MEMORY_GROWTH=1` enabled. |

## AI Agent Team Structure

When this project requires multi-step investigation and implementation, spawn a team using these roles. Each maps to a Claude Code agent type.

| Role | Agent Type | Responsibilities |
|---|---|---|
| **forensics** | `Explore` (read-only) | Deep code analysis — API compatibility, git history diffs, build script auditing, finding silent failures. Returns findings; does NOT edit files. |
| **js-fixer** | `general-purpose` | JS/HTML/CSS/build-script edits. Implements fixes from forensics findings. Runs `npm test` after every change. |
| **test-engineer** | `general-purpose` | Writes new tests in `tests/`. Never modifies existing test files. Verifies full test suite passes after additions. |
| **overseer** | `general-purpose` | Final QA pass. Runs `npm test`, checks `git diff`, validates CLAUDE.md known-bug list, reviews test quality, writes summary report. Spawned last, blocked on js-fixer + test-engineer completing. |

### Team spin-up pattern
```
TeamCreate → TaskCreate (one per role) → Task (spawn agents with team_name) → wait for messages → TaskUpdate(completed) → TeamDelete
```

Set the overseer task `addBlockedBy` on js-fixer and test-engineer task IDs so it only runs after both complete.

## Rules for AI/LLM Assistants

**Tests are ground truth. Do not modify tests to make them pass.**

- If a test fails, the *source code* is wrong, not the test.
- Never weaken assertions, delete test cases, change expected values, or add conditionals to skip failures.
- Never mark a failing test as "expected to fail" or wrap it in `try/catch` to suppress errors.
- If you believe a test is genuinely incorrect, explain why and ask the human to confirm before touching it.
- All changes must pass `npm test` before being committed.
- Do not edit files in `tests/` unless the human explicitly asks you to add new test cases or the test file itself has a syntax error.

## Modernization Goals — Status

1. **WebCodecs playback** — ✅ **DONE** — WASM rebuilt with webcodec plugin; H.264/MXF plays via browser `VideoDecoder`. Direct canvas rendering via `ctx.drawImage(frame)` in `module-loader.js`.
2. **Security** — ✅ path traversal fixed, inline handlers removed, CSP readiness
3. **Accessibility** — ✅ ARIA labels, keyboard navigation; further improvements welcome
4. **Responsive design** — ✅ dark mode, responsive layout (removed hardcoded 1280x720)
5. **Code quality** — ✅ strict equality, extracted inline scripts to `main.js`, modern ES modules
6. **Testing** — ✅ 87 unit tests across 5 files (Vitest); covers libvlc API, server, HTML structure, MXF playback
7. **Build pipeline** — ✅ Dockerized WASM build with Emscripten 4.0.1 + VLC master
8. **CI/CD** — ✅ GitHub Actions workflow at `.github/workflows/test.yml`
