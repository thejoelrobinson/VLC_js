# VLC.js — WebAssembly VLC Media Player

## Project Overview

VLC.js is VLC 4.0 compiled to WebAssembly via Emscripten 4.0.1. It plays video and audio files entirely in the browser using a 31 MB WASM binary containing VLC core + FFmpeg codecs + the webcodec plugin + audio worklet module.

**Upstream source:** https://code.videolan.org/jbk/vlc.js/ (the `incoming` branch, not `master`)
**Working reference demo:** https://videolabs.io/communication/vlcjs-demo/vlc.html (uses VLC 4.0-dev Oct 2022, Emscripten 3.1.18)
**Status:** This fork upgrades to VLC 4.0 master (Jan 2026), Emscripten 4.0.1, working video + audio.

---

## Full Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser UI  (vlc.html + vlc.css)                               │
│  Nav menu, canvas, file picker, progress bar, chapter buttons   │
└──────────────────────┬──────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│  main.js  (app entry point, ES module)                          │
│  · Initializes VLC with option string from localStorage         │
│  · Wires file picker, play/pause, seek, volume events           │
│  · Tracks _vlcIsPlaying state (avoids blocking main thread)     │
│  · Calls update_overlay() and on_overlay_click()                │
└──────────────────────┬──────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│  JS Wrapper Layer                                                │
│  · lib/libvlc.js — MediaPlayer + Media classes (WASM bindings)  │
│  · lib/overlay.js — UI update loop (play/pause icons, timer)    │
│  · lib/module-loader.js — Emscripten Module config + patches    │
└──────────────────────┬──────────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
  ┌──────────┐  ┌───────────┐  ┌───────────────────────────────┐
  │WASM Core │  │  Audio    │  │  Video (WebCodecs path)        │
  │(VLC 4.0) │  │ Pipeline  │  │                                │
  └──────────┘  └───────────┘  └───────────────────────────────┘
```

---

## Video Pipeline (WebCodecs — main path for H.264/MXF)

```
VLC demux thread (pthread)
  └─ MXF/H.264 elementary stream
       │
       ▼
webcodec.cpp Open()  ← VLC calls this to open decoder
  · probeConfig() via EM_ASYNC_JS
    - deferred configure: defer until first chunk (need SPS for codec string)
  · spawns decoder worker thread via vlc_clone()
       │
       ▼
WebcodecDecodeWorker (pthread)
  · initDecoder() creates JS VideoDecoder
  · declareCallbacks() sets up Module.boundOutputCb
  · WebcodecDecodeWorkerTick() calls decoder.decode(chunk) per frame
       │
       ▼  [first chunk arrives]
VideoDecoder.prototype.decode interceptor (experimental.js JS patch)
  · Detects format: Annex B (00 00 00 01 start codes) or AVCC (length-prefix)
  · Extracts actual H.264 profile/level from SPS NAL unit
    - Canon Cinema EOS 4K MXF: avc3.7a0033 (High 4:2:2 Profile Level 5.1)
  · Applies deferred configure() with correct codec string
    - Uses avc3.* (Annex B) not avc1.* (AVCC) — VLC packetizer outputs Annex B
    - avc3 = Annex B; Chrome reads actual params from SPS; no description needed
  · Calls original VideoDecoder.decode(annexBChunk)
       │
       ▼
Browser VideoDecoder (hardware via VideoToolbox on macOS, or SW)
  · Hardware decode of 4K H.264 High 4:2:2 Profile
  · Fires output callback → Module.boundOutputCb(VideoFrame)
       │
       ▼
Module.boundOutputCb (decoder worker)
  · Calls _createAndQueuePicture(ctx, pid, BigInt(timestamp))
    - Tells VLC there is a picture to display (updates vout state machine)
    - Returns null if decoder_UpdateVideoOutput fails (silently skips)
  · Sends frame via callHandler to main thread:
    self.postMessage({cmd:'callHandler', handler:'vlcOnDecoderFrame',
                      args:[pid, VideoFrame]}, [VideoFrame])
       │
       ▼
window._vlcOnDecoderFrame (main thread, module-loader.js)
  · Gets 2D canvas context (_vlcGetCanvas2d())
  · ctx.drawImage(frame, 0, 0, width, height)   ← direct hardware render
  · frame.close()   ← free GPU memory
```

**Why direct canvas rendering instead of VLC's GL pipeline:**
VLC 4.0's WASM vout doesn't properly route `VLC_CODEC_WEBCODEC_OPAQUE` frames to the `glinterop_emscripten` plugin. The `decoder_UpdateVideoOutput` step runs (keeping VLC's state machine happy) but the glinterop `Open()` is never called. Bypassing with `ctx.drawImage(VideoFrame)` works because it's a native browser operation that's hardware-accelerated and requires no GL context setup.

---

## Audio Pipeline (emworklet — Web Audio API AudioWorklet)

```
VLC audio decoder thread (pthread)
  └─ PCM Float32 samples decoded from audio track
       │
       ▼
emscripten.c Open() + Start()
  · Allocates SharedArrayBuffer ring buffer (1 MB + 5×int32 header):
    SAB layout: [is_paused|head|tail|can_write|volume|Float32 samples...]
  · Calls webaudio_init(rate, channels, sab_ptr, latency) → webaudio.js
       │
       ▼
webaudio.js (JS library linked via --js-library)
  · new AudioContext({sampleRate, latencyHint})
  · audioCtx.audioWorklet.addModule('./audio-worklet-processor.js')
  · new AudioWorkletNode(audioCtx, 'worklet-processor', {outputChannelCount})
  · Posts {type:'recv-audio-queue', data:wasmMemory.buffer, sab_ptr} to node
  · node.connect(audioCtx.destination)
  · audioCtx.resume()
       │
       ▼
audio-worklet-processor.js (AudioWorklet thread, separate from main)
  · Receives 'recv-audio-queue' message with SAB views:
    this.head = new Uint32Array(buf, sab_ptr+4, 1)
    this.tail = new Uint32Array(buf, sab_ptr+8, 1)
    this.can_write = new Int32Array(buf, sab_ptr+12, 1)
    this.volume = new Int32Array(buf, sab_ptr+16, 1)
    this.storage = new Float32Array(buf, sab_ptr+20, STORAGE_SIZE/4)
  · process() called by browser at audio rate (44.1 kHz):
    - Reads head/tail via Atomics.load (lock-free ring buffer)
    - Copies samples storage[tail..head] → output channels
    - Applies volume scaling (Atomics.load(volume) / 400)
    - Updates tail via Atomics.store, wakes VLC via Atomics.notify
       │
       ▲
emscripten.c Play() callback (VLC audio decode thread, runs continuously)
  · Writes Float32 samples to SAB storage ring buffer
  · Advances head pointer via Atomics.store
  · Calls js_index_wait() if buffer full → Atomics.wait until space
```

**SharedArrayBuffer requirement:** Both WASM and AudioWorklet need SharedArrayBuffer access. The server serves COOP/COEP headers which enable this. AudioWorklet runs in a separate thread; ring buffer + Atomics provides zero-copy, low-latency audio without MessagePort overhead.

---

## Key Files

| File | Editable? | Purpose |
|---|---|---|
| `main.js` | YES | App entry point — VLC init, event wiring, `window._vlcIsPlaying` state |
| `lib/libvlc.js` | YES | `MediaPlayer` + `Media` wrapping WASM calls; `is_playing()` returns cached state (VLC 4.0 `vlc_player_Lock` blocks main thread) |
| `lib/overlay.js` | YES | UI update loop; uses `window._vlcIsPlaying` NOT `is_playing()` |
| `lib/module-loader.js` | YES | Emscripten Module config; VideoDecoder patches; `_vlcOnDecoderFrame` direct canvas renderer; audio frame storage |
| `audio-worklet-processor.js` | YES | SAB + Atomics ring buffer AudioWorklet processor |
| `vlc.html` | YES | Main page (114 lines); scripts extracted to `main.js` |
| `vlc.css` | YES | Responsive dark-mode styles |
| `server.js` | YES | Dev server — COOP/COEP headers, path traversal protection |
| `build/compile.sh` | YES | Build script — injects webcodec + audio C sources, applies patches |
| `build/Dockerfile` | YES | Multi-stage Docker build for reproducible WASM |
| `build/webcodec/` | YES | webcodec VLC plugin: `webcodec.cpp`, `interop_emscripten.cpp`, `common.h` |
| `build/audio/` | YES | Audio worklet VLC module: `emscripten.c`, `webaudio.c/h`, `audio-worklet-processor.js` |
| `build/js-libs/webaudio.js` | YES | JS library for emcc `--js-library` — provides `webaudio_init/getSampleRate/getChannels` |
| `build/vlc_patches/aug/` | YES | 81 patch files applied to VLC source before build |
| `tests/` | YES (add) | 93 Vitest tests: libvlc API, server, HTML, MXF playback, browser integration |
| `experimental.js` | NO* | Emscripten-generated glue (~367 KB); see JS patches section below |
| `experimental.wasm` | NO | Compiled binary (31 MB) — requires Docker rebuild to change |
| `experimental.worker.js` | NO | Emscripten worker bootstrap |

---

## experimental.js JS Patches

The compiled `experimental.js` requires runtime JS patches to work with VLC 4.0 / Emscripten 4.0.1. These are applied after every Docker build:

| Patch | Location | Why |
|---|---|---|
| VideoDecoder deferred configure | Top of file (prototype) | Defer `configure()` until first chunk arrives so SPS codec can be read; use `avc3.7a0033` (Annex B, correct H.264 profile) |
| probeConfig dimension + codec fix | `probeConfig` function | Zero dimensions rejected by `isConfigSupported`; bare `avc1` → `avc3.7a0033` |
| `globalThis.Module` → `Module` | webcodec EM_JS functions | `globalThis.Module` undefined on worker threads; use closure var `Module` |
| `bindVideoFrame` → `window._vlcAwaitFrame` | `__asyncjs__bindVideoFrame` | VLC 4.0 glinterop never opens; route frames through JS-side frame storage |
| `boundOutputCb` null guard | boundOutputCb function | Prevent null `webCodecCtx` from causing WASM heap corruption |

These patches are applied by the Python script in the deploy step. The source fixes are in `build/webcodec/webcodec.cpp` and `build/js-libs/webaudio.js` for future rebuilds.

---

## WASM Build Pipeline

```
docker compose -f build/docker-compose.yml build
docker compose -f build/docker-compose.yml up   ← copies artifacts to project root
```

**Build steps in `build/compile.sh`:**

1. Activate Emscripten SDK 4.0.1
2. Clone VLC master at commit `65e744b0` (2026-01-29)
3. Apply `build/vlc_patches/aug/` patch series (most skip as already merged)
4. **Step 3b: Inject webcodec sources** (`build/webcodec/` → VLC tree)
   - Copies `webcodec.cpp`, `interop_emscripten.cpp`, `common.h`
   - Injects `VLC_DECODER_DEVICE_WEBCODEC`, `VLC_VIDEO_CONTEXT_WEBCODEC`, `VLC_CODEC_WEBCODEC_OPAQUE` into headers via `sed`
   - Adds `libwebcodec_plugin.la` to `modules/codec/Makefile.am`
5. **Step 3c: Inject audio sources** (`build/audio/` → VLC tree)
   - Copies `emscripten.c`, `webaudio.c/h`, `audio-worklet-processor.js`
   - Adds `libemworklet_audio_plugin.la` to `modules/audio_output/Makefile.am`
6. Run VLC's built-in WASM build (`extras/package/wasm-emscripten/build.sh`)
7. Generate symbol export list (`libvlc_wasm.sym`)
8. Final `emcc` link step (`create_main.sh`) with:
   - `--js-library js-libs/wasm-imports.js` (file access module)
   - `--js-library js-libs/webaudio.js` (audio bridge functions)
   - All flags: USE_PTHREADS, TOTAL_MEMORY=2GB, ALLOW_MEMORY_GROWTH, PTHREAD_POOL_SIZE=25, ASYNCIFY=1, MODULARIZE=1, OFFSCREENCANVAS_SUPPORT=1, etc.

**Time:** ~45 minutes from scratch (downloads FFmpeg, VLC contribs)

---

## VLC 4.0 API Gotchas

Things that changed in VLC 4.0 and require workarounds:

| API | Old (VLC 3.x) | New (VLC 4.0) | Fix |
|---|---|---|---|
| `vlc_thread_t` | `typedef pthread_t` | Opaque handle | Can't assign `sys->th` to `pthread_t decoder_worker` |
| `dec->fmt_in.X` | Direct struct access | `dec->fmt_in->X` (pointer) | All fmt_in accesses use `->` |
| `vlc_clone()` | 4 args (includes priority) | 3 args (no priority) | Remove 4th arg |
| `vout_window_t` | Window type | `vlc_window_t` | Rename |
| `i_rmask/i_gmask/i_bmask` | In `video_format_t` | Removed | Don't reference |
| `typeof()` macro | In `vlc_fixups.h` | Breaks emscripten/val.h | `#undef typeof` before `#include <emscripten/val.h>` |
| `aout_TimeGetDefault()` | audio time helper | Removed | Return `VLC_EGENERIC` directly |
| `libvlc_media_player_is_playing()` | Non-blocking read | Acquires `vlc_player_Lock` → `pthread_cond_timedwait` → **blocks main browser thread** → WASM abort | Cache state in `window._vlcIsPlaying`; overlay.js uses cache, NOT WASM call |

---

## Default VLC Options

```
--codec=webcodec --aout=emworklet --avcodec-threads=1
```

| Option | Why |
|---|---|
| `--codec=webcodec` | Force browser VideoDecoder (hardware H.264) instead of FFmpeg |
| `--aout=emworklet` | Enable AudioWorklet output module (module shortname: `emworklet`) |
| `--avcodec-threads=1` | Fallback: if webcodec fails, prevents FFmpeg frame-threading exhausting PTHREAD_POOL_SIZE=25 |

---

## WASM Function Interface

The JS layer calls WASM via `module._wasm_*()`. Key exports:

```javascript
// Initialization
module._wasm_libvlc_init(argc, argv_ptr)

// Media player
module._wasm_media_player_new() → ptr
module._wasm_media_player_play(ptr)
module._wasm_media_player_set_pause(ptr, do_pause)  // use this, NOT pause()
module._wasm_media_player_stop(ptr)
module._wasm_media_player_get_time(ptr) → BigInt (VLC 4.0)
module._wasm_media_player_set_time(ptr, time_ms, fast)
module._wasm_media_player_get_position(ptr) → float
module._wasm_media_player_set_position(ptr, pos, fast)
module._wasm_media_player_get_length(ptr) → BigInt (VLC 4.0)
module._wasm_media_player_is_playing(ptr) → int  // DO NOT call from main thread

// Media
module._wasm_media_new_location(path_ptr) → ptr

// Audio (volume 0-100)
module._wasm_audio_get_volume(ptr) → int
module._wasm_audio_set_volume(ptr, vol)
module._wasm_audio_get_mute(ptr) → bool
module._wasm_audio_set_mute(ptr, bool)

// Misc
module._set_global_media_player(ptr)
module._attach_update_events(ptr)
```

**VLC 4.0 BigInt returns:** `get_time()` and `get_length()` return `BigInt`. Always wrap in `Number()` before arithmetic: `Number(media_player.get_time())`.

Emscripten helpers: `allocateUTF8()`, `_free()`, `_malloc()`, `writeAsciiToMemory()`, `wasmMemory`, `PThread`.

---

## Testing

```bash
npm test               # 93 unit tests (Vitest)
npm run test:browser   # Browser integration test — decodes ≥10 VideoFrames from MXF
npm run test:watch     # Watch mode
```

**Test files:**
- `tests/libvlc.test.js` — 35 tests: MediaPlayer API, all WASM bindings mocked
- `tests/server.test.js` — 9 tests: server routing, COOP/COEP headers, path traversal
- `tests/html-structure.test.js` — 17 tests: DOM structure, ARIA, accessibility
- `tests/mxf-playback.test.js` — 26 tests: VLC options, codec parsing, BigInt handling
- `tests/mxf-browser-playback.test.js` — 6 tests: real browser, actual decode of Canon MXF

**Test rules:** Tests are ground truth. Never modify tests to make them pass. If a test fails, the source code is wrong.

---

## Browser Requirements

- **SharedArrayBuffer** — requires COOP/COEP headers (server.js provides these)
- **WebCodecs VideoDecoder** — Chrome 94+; `VideoDecoder.decode()`, `VideoFrame`
- **AudioWorklet** — Chrome 66+; required for audio
- **WebGL2** — required by VLC's vout (even though WebCodecs bypasses it for rendering)
- **WASM threads** (pthreads via SharedArrayBuffer)
- **Chrome/Edge recommended.** Firefox needs `dom.postMessage.sharedArrayBuffer.bypassCOOP_COEP.insecure.enabled=true`.

---

## Development

```bash
npm start              # Dev server at http://localhost:3000
npm test               # 93 unit tests
npm run test:browser   # Browser test (server must be running)
```

After Docker rebuild, re-apply JS patches to experimental.js:
```python
# See the patch application script pattern in prior sessions
# Patches: VideoDecoder avc3.7a0033, probeConfig, globalThis.Module,
#          bindVideoFrame, boundOutputCb null guard
```

---

## Git History

- `main` — active branch; all work merged here
- `v1.0-working` — tag for original 2020 distribution (`ed4128f`); use as reference
- `9c2222d` — WebCodecs H.264 video playback working
- `48495ef` — Audio output working (emworklet + AudioWorklet)

---

## AI Agent Team Structure

Spawn teams for complex multi-step work:

| Role | Agent Type | Responsibilities |
|---|---|---|
| **forensics** | `Explore` (read-only) | Deep code analysis, API diffs, build auditing |
| **js-fixer** | `general-purpose` | JS/CSS/build edits; runs `npm test` after each change |
| **test-engineer** | `general-purpose` | Writes new tests; never modifies existing test files |
| **overseer** | `general-purpose` | Final QA: runs tests, checks git diff, writes report |

Spin-up: `TeamCreate → TaskCreate → Task (agents) → wait → TeamDelete`
Set overseer task `addBlockedBy` on js-fixer + test-engineer IDs.

---

## Rules for AI/LLM Assistants

**Tests are ground truth. Do not modify tests to make them pass.**

- If a test fails, the *source code* is wrong, not the test.
- Never weaken assertions, delete test cases, change expected values, or skip failures.
- If a test is genuinely wrong, explain why and ask the human to confirm before touching it.
- All changes must pass `npm test` before being committed.
- Do not edit `tests/` unless explicitly asked to add new test cases.
