"use strict";
// Patch VideoDecoder.configure to handle bare 'avc1' codec strings.
// VLC's webcodec module may not have profile/level at configure() time when
// the MXF demuxer hasn't yet provided AVCC extradata. Bare 'avc1' is rejected
// by Chrome; use High Profile Level 4.0 as a safe fallback.
if (typeof VideoDecoder !== 'undefined') {
    const _OrigVideoDecoder = VideoDecoder;
    // Track whether the decoder has reached 'configured' state at least once.
    // Used by the recovery path: once we know the decoder was successfully
    // configured (with avc3.7a0033 via the deferred-configure pre-js patch),
    // we can reconfigure it with the same codec if a backward seek causes it
    // to enter 'closed' state from receiving non-decodable delta frames.
    let _decoderEverConfigured = false;
    let _seekRecoveries = 0; // limit recovery attempts per seek cycle
    class PatchedVideoDecoder extends _OrigVideoDecoder {
        configure(config) {
            if (config && config.codec === 'avc1') {
                config = Object.assign({}, config, { codec: 'avc1.640028' });
                console.log('[webcodec] configure: bare avc1 -> avc1.640028 (High Profile fallback)');
                // Fresh decoder instance — reset recovery state for this session.
                _decoderEverConfigured = false;
                _seekRecoveries = 0;
            }
            return super.configure(config);
        }
        decode(chunk) {
            // Track when the decoder first reaches 'configured' (deferred configure fired).
            if (this.state === 'configured') _decoderEverConfigured = true;
            // ── Backward-seek recovery ───────────────────────────────────────────
            // Problem: Flush() in webcodec.cpp is a no-op (thread-affinity constraint).
            // Pre-seek delta frames in the block queue reach the VideoDecoder before
            // the IDR; the decoder rejects them → state becomes 'closed'.
            // The videodecoder-deferred-configure.js pre-js then silently drops the
            // IDR (line: `if (this.state === "closed") return;`), leaving the frame frozen.
            //
            // Fix: when 'closed' AND we receive a keyframe AND we know a good config
            // was used before, reconfigure with the Annex B codec (avc3.7a0033 — no
            // description needed; SPS is in the bitstream) then decode the IDR.
            if (this.state === 'closed' && chunk.type === 'key' &&
                _decoderEverConfigured && _seekRecoveries < 3) {
                _seekRecoveries++;
                console.log('[webcodec] seek recovery: reconfiguring decoder after closed state (attempt ' + _seekRecoveries + ')');
                try {
                    // super.configure with avc3.7a0033 bypasses the deferred-configure
                    // deferral (it only defers avc1.* codecs) and calls the true original
                    // VideoDecoder.configure directly. This resets state to 'configured'.
                    super.configure({ codec: 'avc3.7a0033', optimizeForLatency: true });
                } catch(e) {
                    console.warn('[webcodec] seek recovery configure failed:', e);
                    return;
                }
            }
            // Reset recovery counter once the decoder is healthy again (state is configured).
            if (this.state === 'configured' && _seekRecoveries > 0) _seekRecoveries = 0;
            // Don't call decode() on a closed decoder with a delta chunk — it throws
            // synchronously and the exception propagates through emval into the WASM
            // tick where it corrupts ASYNCIFY's saved stack → "function signature
            // mismatch" at EOS.  Silently drop the frame; the next keyframe triggers
            // the closed-state recovery above and resumes normal decoding.
            if (this.state === 'closed' && chunk.type === 'delta') return;
            return super.decode(chunk);
        }
    }
    // Preserve static methods
    PatchedVideoDecoder.isConfigSupported = _OrigVideoDecoder.isConfigSupported.bind(_OrigVideoDecoder);
    window.VideoDecoder = PatchedVideoDecoder;
}
// vlcOnDecoderFrame: called on the MAIN THREAD via Emscripten's callHandler mechanism
// when the decoder worker has a decoded VideoFrame ready. This runs on the main thread
// (where Module.glConv is set by initGlConvWorker, since VLC's GL renderer runs on
// the main thread in this Emscripten pthreads build).
// The pictureId and frame are delivered directly here, bypassing MessagePort.
const _vlcPendingFrames = {};
const _vlcFrameResolvers = {};
let _vlcRenderPort1 = null;
window._vlcSetRenderPort1 = function (port1) {
    _vlcRenderPort1 = port1;
    console.log('[webcodec] render MessageChannel port1 received on main thread');
};
// Direct canvas rendering: draw VideoFrame directly to the canvas using 2D context.
// This bypasses VLC's rendering pipeline (glinterop) entirely — VLC 4.0's WASM vout
// doesn't properly route VLC_CODEC_WEBCODEC_OPAQUE to the glinterop plugin.
// VideoFrame.drawToCanvas() / ctx.drawImage(frame) is the correct native approach.
let _vlcCanvas2d = null;
function _vlcGetCanvas2d() {
    if (_vlcCanvas2d)
        return _vlcCanvas2d;
    const canvas = document.getElementById('canvas');
    if (!canvas)
        return null;
    // Try to get/create a 2D context for direct frame rendering.
    // If canvas has been transferred to OffscreenCanvas worker (WebGL), we create
    // an overlay canvas on top and render there instead.
    try {
        const ctx = canvas.getContext('2d');
        if (ctx) {
            _vlcCanvas2d = ctx;
            return ctx;
        }
    }
    catch (e) { /* canvas may have webgl context */ }
    // Create overlay canvas
    const overlay = document.createElement('canvas');
    overlay.width = canvas.width || 1280;
    overlay.height = canvas.height || 720;
    overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
    canvas.parentNode?.insertBefore(overlay, canvas.nextSibling) ||
        document.body.appendChild(overlay);
    _vlcCanvas2d = overlay.getContext('2d');
    return _vlcCanvas2d;
}
// Eagerly initialise the state cache so the RAF loop can read/write it
// before the first frame arrives (e.g. to poll for video length).
window._vlcStateCache = { position: 0, timeMs: 0, lengthMs: 0, volume: 80, muted: false, chapter: -1, chapterCount: 0 };
// FPS estimation: rolling window of inter-frame intervals (microseconds).
// Used to compute frame-step duration for the `,`/`.` keyboard shortcuts.
const _vlcFrameIntervals = [];
let _vlcLastFrameTimestampUs = null;
const _VLC_FPS_WINDOW = 10; // rolling average over last 10 frames
const _VLC_FPS_MIN = 5;
const _VLC_FPS_MAX = 120;
window._vlcOnDecoderFrame = function (pictureId, frame) {
    // Update _vlcStateCache from VideoFrame timestamp so the overlay progress bar works.
    // VideoFrame.timestamp is in microseconds; convert to milliseconds.
    if (frame && frame instanceof VideoFrame && frame.timestamp != null) {
        const cache = window._vlcStateCache; // eagerly initialised above
        const newTimeMs = Math.round(frame.timestamp / 1000);
        // ── FPS estimation ───────────────────────────────────────────────────────
        // Compute inter-frame interval from consecutive VideoFrame timestamps.
        // Timestamps are in microseconds; accumulate in a rolling window and
        // derive a smoothed FPS. Clamped to the 5–120 fps range so outlier
        // frames (codec gaps, seeks) don't produce absurd step durations.
        if (_vlcLastFrameTimestampUs !== null) {
            const intervalUs = frame.timestamp - _vlcLastFrameTimestampUs;
            if (intervalUs > 0) {
                _vlcFrameIntervals.push(intervalUs);
                if (_vlcFrameIntervals.length > _VLC_FPS_WINDOW) {
                    _vlcFrameIntervals.shift();
                }
                const avgUs = _vlcFrameIntervals.reduce((a, b) => a + b, 0) / _vlcFrameIntervals.length;
                const fps = 1000000 / avgUs;
                window._vlcEstimatedFps = Math.max(_VLC_FPS_MIN, Math.min(_VLC_FPS_MAX, fps));
            }
        }
        _vlcLastFrameTimestampUs = frame.timestamp;
        // ── timeMs update ────────────────────────────────────────────────────────
        cache.timeMs = newTimeMs;
        // After a seek, _applySeek sets _vlcPendingSeekMs to the target timeMs and
        // writes an immediate position to the cache for instant playhead feedback.
        // Ignore frames that are far from the seek target (pre-seek pipeline flush),
        // using absolute distance so both forward AND backward seeks are handled.
        const pendingMs = window._vlcPendingSeekMs ?? 0;
        const isFarFromTarget = pendingMs > 0 && Math.abs(newTimeMs - pendingMs) > 1500;
        if (isFarFromTarget) {
            // Pre-seek frame (old pipeline) — keep the immediate feedback position.
        }
        else {
            if (pendingMs > 0)
                window._vlcPendingSeekMs = 0; // seek reached
            // During scrubbing the drag position is authoritative — do NOT let
            // incoming frames overwrite cache.position (would cause playhead jitter).
            if (!window._vlcIsScrubbing && cache.lengthMs > 0) {
                cache.position = newTimeMs / cache.lengthMs;
            }
        }
    }
    // PRIMARY PATH: route via MessagePort to OffscreenCanvas render worker (off main thread)
    if (_vlcRenderPort1 && frame && frame instanceof VideoFrame) {
        _vlcRenderPort1.postMessage({ pid: pictureId, frame }, [frame]);
        return;
    }
    // FALLBACK PATH: Draw VideoFrame directly to canvas using 2D context on main thread.
    // VLC 4.0's WASM vout doesn't route VLC_CODEC_WEBCODEC_OPAQUE to the glinterop,
    // so we bypass VLC's rendering pipeline and render directly.
    // ctx.drawImage(VideoFrame) is natively supported and hardware-accelerated.
    const ctx = _vlcGetCanvas2d();
    if (ctx && frame && frame instanceof VideoFrame) {
        ctx.drawImage(frame, 0, 0, ctx.canvas.width, ctx.canvas.height);
        frame.close(); // free GPU memory after drawing
        return;
    }
    // TERTIARY PATH (if canvas unavailable): try Module.glConv or local frame resolvers
    const idx = pictureId % 32;
    // Fallback: try Module.glConv or local frame resolvers
    const gc = window.Module && window.Module.glConv;
    if (gc) {
        if (gc.promiseResolvers[idx]) {
            const resolve = gc.promiseResolvers[idx];
            delete gc.promiseResolvers[idx];
            resolve(frame);
        }
        else {
            gc.frameQueue[idx] = frame;
        }
    }
    else {
        if (_vlcFrameResolvers[idx]) {
            const resolve = _vlcFrameResolvers[idx];
            delete _vlcFrameResolvers[idx];
            resolve(frame);
        }
        else {
            _vlcPendingFrames[idx] = frame;
        }
    }
};
window._vlcAwaitFrame = async function (pictureId) {
    const idx = pictureId % 32;
    // Prefer Module.glConv (set by initGlConvWorker) if accessible
    const gc = window.Module && window.Module.glConv;
    if (gc) {
        if (gc.frameQueue[idx]) {
            const f = gc.frameQueue[idx];
            delete gc.frameQueue[idx];
            return f;
        }
        return new Promise(resolve => { gc.promiseResolvers[idx] = resolve; });
    }
    if (_vlcPendingFrames[idx]) {
        const f = _vlcPendingFrames[idx];
        delete _vlcPendingFrames[idx];
        return f;
    }
    return new Promise(resolve => { _vlcFrameResolvers[idx] = resolve; });
};
// DOM elements and events shared with main.ts via the global script scope.
// These are declared as `var` so they merge with ambient declarations in globals.d.ts
// and remain accessible from main.ts (ES module) as unqualified globals.
var spinnerElement = document.getElementById('spinner');
var overlayElement = document.getElementById('canvas');
var spinnerLdsElement = document.getElementById('spinner-lds');
var body = document.getElementById('body');
var isLoading = new CustomEvent('isLoading', { detail: { loading: true } });
var isNotLoading = new CustomEvent('isLoading', { detail: { loading: false } });
var VlcModuleExt = {
    preRun: [function () {
            window.display_overlay = true;
        }],
    vlc_access_file: {},
    // callHandler targets for frame routing
    vlcOnDecoderFrame: window._vlcOnDecoderFrame,
    vlcSetRenderPort1: window._vlcSetRenderPort1,
    onRuntimeInitialized: function () { },
    print: (() => {
        const element = document.getElementById('output');
        if (element)
            element.value = '';
        return (...args) => {
            const text = args.join(' ');
            console.log(text);
            if (element) {
                element.value += text + "\n";
                element.scrollTop = element.scrollHeight;
            }
        };
    })(),
    printErr: (...args) => {
        const text = args.join(' ');
        console.error(text);
    },
    canvas: (function () {
        const canvas = document.getElementById('canvas');
        canvas.addEventListener("webglcontextlost", function (e) {
            console.error('WebGL context lost. You will need to reload the page.');
            e.preventDefault();
        });
        return canvas;
    })(),
    setStatus: function (text) {
        const last = VlcModuleExt.setStatus;
        if (!last.last)
            last.last = { time: Date.now(), text: '' };
        if (text === last.last.text)
            return;
        const m = text.match(/([^(]+)\((\d+(\.\d+)?)\/(\d+)\)/);
        const now = Date.now();
        if (m && now - last.last.time < 30)
            return;
        last.last.time = now;
        last.last.text = text;
        if (m) {
            body.dispatchEvent(isLoading);
        }
        else {
            body.dispatchEvent(isNotLoading);
        }
    },
    totalDependencies: 0,
    monitorRunDependencies: function (left) {
        this.totalDependencies = Math.max(this.totalDependencies, left);
        VlcModuleExt.setStatus(left ? 'Preparing... (' + (this.totalDependencies - left) + '/' + this.totalDependencies + ')' : 'All downloads complete.');
    }
};
// OffscreenCanvas render worker setup — moves VideoFrame drawing off the main thread.
// Guarded by feature detection: requires Worker + OffscreenCanvas + transferControlToOffscreen.
function _initRenderWorker() {
    if (typeof Worker === 'undefined')
        return;
    if (!('transferControlToOffscreen' in HTMLCanvasElement.prototype))
        return;
    const mainCanvas = document.getElementById('canvas');
    if (!mainCanvas)
        return;
    // Create overlay canvas for WebCodecs 2D rendering (main canvas has WebGL context)
    const overlay = document.createElement('canvas');
    overlay.width = mainCanvas.width || 1280;
    overlay.height = mainCanvas.height || 720;
    // No z-index — the overlay is inserted before #p-overlay in the DOM, so it
    // naturally stacks behind the controls (earlier DOM order = behind, for
    // position:absolute elements sharing the same z-index:auto level).
    // Positioned elements are still in front of the static main canvas.
    overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
    mainCanvas.parentNode?.insertBefore(overlay, mainCanvas.nextSibling);
    // Transfer overlay to OffscreenCanvas for worker rendering
    let offscreen;
    try {
        offscreen = overlay.transferControlToOffscreen();
    }
    catch (e) {
        console.warn('[webcodec] transferControlToOffscreen failed:', e);
        return;
    }
    // Clear cached 2D context — _vlcGetCanvas2d should not try to use the transferred canvas
    _vlcCanvas2d = null;
    try {
        const worker = new Worker('./lib/render-worker.js');
        const { port1, port2 } = new MessageChannel();
        worker.postMessage({ type: 'init', offscreen, port: port2 }, [offscreen, port2]);
        // Store port1 — _vlcOnDecoderFrame will route frames to the worker via this port
        _vlcRenderPort1 = port1;
        worker.onerror = function (e) {
            console.warn('[webcodec] render worker error, falling back to main-thread rendering:', e);
            _vlcRenderPort1 = null;
        };
        console.log('[webcodec] OffscreenCanvas render worker started');
    }
    catch (e) {
        console.warn('[webcodec] Failed to start render worker, using main-thread rendering:', e);
    }
}
// Attempt eager OffscreenCanvas setup once DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initRenderWorker);
}
else {
    _initRenderWorker();
}
// Warm browser HTTP cache for AudioWorklet processor (saves 30-100ms on first play).
// webaudio.js calls audioCtx.audioWorklet.addModule('./audio-worklet-processor.js');
// a prior fetch() ensures that call gets a cache hit rather than a fresh HTTP fetch.
fetch('./audio-worklet-processor.js').catch(() => {});
