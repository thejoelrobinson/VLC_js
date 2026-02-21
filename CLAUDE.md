# VLC.js — WebAssembly VLC Media Player

## Project Overview

VLC.js is VLC media player compiled to WebAssembly via Emscripten. It plays video/audio files entirely in the browser using a 26 MB WASM binary containing VLC core + FFmpeg codecs.

**Upstream source:** https://code.videolan.org/jbk/vlc.js/ (use `incoming` branch, not `master`)
**Status:** Upstream is unmaintained (last commit Oct 2022). This fork modernizes the JS layer and build pipeline.

## Architecture

```
Browser UI (vlc.html, vlc.css)
    ↓
JS Wrapper Layer (lib/libvlc.js, lib/overlay.js, lib/module-loader.js)
    ↓
Emscripten Glue (experimental.js) — generated, do not hand-edit
    ↓
WASM Binary (experimental.wasm) — compiled VLC + FFmpeg, 26 MB
    ↓
Web Workers (experimental.worker.js) — POSIX thread emulation
    ↓
Audio Output (audio-worklet-processor.js) — Web Audio API AudioWorklet
```

## Key Files

| File | Editable? | Purpose |
|---|---|---|
| `lib/libvlc.js` | YES | `MediaPlayer` and `Media` classes wrapping WASM function calls |
| `lib/overlay.js` | YES | UI controls: play/pause, progress bar, volume, chapters |
| `lib/module-loader.js` | YES | Emscripten module initialization and configuration |
| `vlc.html` | YES | Main page — canvas, file picker, inline init script |
| `vlc.css` | YES | All styling — hardcoded 1280x720, not responsive |
| `audio-worklet-processor.js` | YES | AudioWorklet receiving PCM from WASM |
| `server.js` | YES | Dev server (Node.js, serves COOP/COEP headers for SharedArrayBuffer) |
| `experimental.js` | NO | Emscripten-generated glue code (~382 KB minified) |
| `experimental.wasm` | NO | Compiled binary — requires full Emscripten rebuild to change |
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
npm test               # Run unit tests (Vitest)
npm run test:watch     # Run tests in watch mode
```

## Git Workflow

- `main` — protected, the known-working v1.0 distribution. Never commit directly.
- `dev/js-updates` — active development branch for JS/HTML/CSS changes.
- `dev/wasm-rebuild` — for WASM binary rebuild attempts (future).
- Tag `v1.0-working` — permanent reference to the original working state.

## Upstream Build (for WASM rebuilds)

The upstream `incoming` branch uses:
- **Emscripten SDK 3.1.18** (outdated — current is 3.1.70+)
- **VLC** pinned to a 2022-era commit
- **Docker image:** `registry.videolan.org/vlc-debian-wasm-emscripten:20220505193036`
- Build: `bash compile.sh` → clones VLC, applies patches, runs `emcc` link step
- Output: `experimental.js`, `experimental.wasm`, `experimental.worker.js`

Key Emscripten flags used in the link step:
```
-s USE_PTHREADS=1
-s TOTAL_MEMORY=2GB
-s PTHREAD_POOL_SIZE=25
-s OFFSCREEN_FRAMEBUFFER=1
-s USE_WEBGL2=1
-s MODULARIZE=1
-s EXPORT_NAME="initModule"
-s ASYNCIFY=1
-O3
```

## Known Bugs — Status

All four original bugs are **fixed** in `dev/js-updates`:

1. `lib/libvlc.js:239` — ~~template literal missing `$`~~ — **FIXED**
2. `lib/module-loader.js:10,13` — ~~duplicate `var was_clicked`~~ — **FIXED**
3. `server.js:21` — ~~no path traversal protection~~ — **FIXED** (resolves path, checks startsWith ROOT)
4. `vlc.html:45` — ~~inline `oncontextmenu`~~ — **FIXED** (moved to `addEventListener` in main.js)

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

## Modernization Goals

**Primary goal: Full WebCodecs playback — feature-complete and as functional as the original v1.0 build.**

The `webcodec` VLC plugin (in `build/webcodec/`) must be compiled into the WASM binary so VLC uses the browser's native `VideoDecoder` API (WebCodecs) for H.264 and other hardware-accelerated codecs. This avoids FFmpeg frame threading (`thread_get_buffer()` failures) and gives native-speed decode.

1. **WebCodecs playback** — rebuild WASM with webcodec plugin; MXF, H.264, HEVC via browser VideoDecoder ← **TOP PRIORITY**
2. **Security** — ✅ path traversal fixed, inline handlers removed, CSP readiness
3. **Accessibility** — ✅ ARIA labels, keyboard navigation; further improvements welcome
4. **Responsive design** — mobile/tablet support, remove hardcoded 1280x720
5. **Code quality** — ✅ strict equality, extracted inline scripts, modern JS patterns
6. **Testing** — ✅ unit tests for JS wrapper, server, UI logic, MXF playback paths
7. **Build pipeline** — Dockerized WASM build, Emscripten SDK upgrade
8. **CI/CD** — GitHub Actions for tests and optional WASM rebuild
