// Patch VideoDecoder.configure to handle bare 'avc1' codec strings.
// VLC's webcodec module may not have profile/level at configure() time when
// the MXF demuxer hasn't yet provided AVCC extradata. Bare 'avc1' is rejected
// by Chrome; use High Profile Level 4.0 as a safe fallback.
if (typeof VideoDecoder !== 'undefined') {
  const _OrigVideoDecoder = VideoDecoder;
  class PatchedVideoDecoder extends _OrigVideoDecoder {
    configure(config) {
      if (config && config.codec === 'avc1') {
        config = Object.assign({}, config, { codec: 'avc1.640028' });
        console.log('[webcodec] configure: bare avc1 -> avc1.640028 (High Profile fallback)');
      }
      return super.configure(config);
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
let _vlcRenderPort1 = null; // set when rendering worker sends us its channel port

window._vlcSetRenderPort1 = function(port1) {
  _vlcRenderPort1 = port1;
  console.log('[webcodec] render MessageChannel port1 received on main thread');
};

// Direct canvas rendering: draw VideoFrame directly to the canvas using 2D context.
// This bypasses VLC's rendering pipeline (glinterop) entirely — VLC 4.0's WASM vout
// doesn't properly route VLC_CODEC_WEBCODEC_OPAQUE to the glinterop plugin.
// VideoFrame.drawToCanvas() / ctx.drawImage(frame) is the correct native approach.
let _vlcCanvas2d = null;
function _vlcGetCanvas2d() {
  if (_vlcCanvas2d) return _vlcCanvas2d;
  const canvas = document.getElementById('canvas');
  if (!canvas) return null;
  // Try to get/create a 2D context for direct frame rendering.
  // If canvas has been transferred to OffscreenCanvas worker (WebGL), we create
  // an overlay canvas on top and render there instead.
  try {
    const ctx = canvas.getContext('2d');
    if (ctx) { _vlcCanvas2d = ctx; return ctx; }
  } catch(e) { /* canvas may have webgl context */ }
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

// VLC state cache — all values that overlay.js needs for display.
// Updated from frame timestamps (main path) and user interaction hooks.
// NEVER read directly from WASM on the main thread: vlc_player_Lock in
// VLC 4.0 acquires pthread_cond_timedwait → blocks browser main thread → abort.
window._vlcStateCache = {
  position: 0,      // 0.0–1.0
  timeMs: 0,        // milliseconds
  lengthMs: 0,      // milliseconds (set when first known)
  volume: 80,       // 0–100
  muted: false,
  chapter: 0,
  chapterCount: 0,
};

window._vlcOnDecoderFrame = function(pictureId, frame) {
  // Update time/position cache from frame timestamp (microseconds → ms).
  // frame.timestamp is the presentation timestamp from the VideoDecoder.
  // This keeps the overlay timer accurate without calling vlc_player_Lock.
  if (frame instanceof VideoFrame) {
    const timeMs = frame.timestamp / 1000;
    window._vlcStateCache.timeMs = timeMs;
    if (window._vlcStateCache.lengthMs > 0) {
      window._vlcStateCache.position = Math.min(1, timeMs / window._vlcStateCache.lengthMs);
    }
  }

  // PRIMARY PATH: Draw VideoFrame directly to canvas using 2D context.
  // VLC 4.0's WASM vout doesn't route VLC_CODEC_WEBCODEC_OPAQUE to the glinterop,
  // so we bypass VLC's rendering pipeline and render directly.
  // ctx.drawImage(VideoFrame) is natively supported and hardware-accelerated.
  const ctx = _vlcGetCanvas2d();
  if (ctx && frame && frame instanceof VideoFrame) {
    ctx.drawImage(frame, 0, 0, ctx.canvas.width, ctx.canvas.height);
    frame.close(); // free GPU memory after drawing
    return;
  }

  // SECONDARY PATH (if canvas unavailable): route via MessageChannel to rendering worker
  const idx = pictureId % 32;
  if (_vlcRenderPort1) {
    _vlcRenderPort1.postMessage({ pid: pictureId, frame }, [frame]);
    return;
  }
  // Fallback: try Module.glConv or local frame resolvers
  const gc = window.Module && window.Module.glConv;
  if (gc) {
    if (gc.promiseResolvers[idx]) {
      const resolve = gc.promiseResolvers[idx];
      delete gc.promiseResolvers[idx];
      resolve(frame);
    } else {
      gc.frameQueue[idx] = frame;
    }
  } else {
    if (_vlcFrameResolvers[idx]) {
      const resolve = _vlcFrameResolvers[idx];
      delete _vlcFrameResolvers[idx];
      resolve(frame);
    } else {
      _vlcPendingFrames[idx] = frame;
    }
  }
};
window._vlcAwaitFrame = async function(pictureId) {
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

const spinnerElement = document.getElementById('spinner');
const overlayElement = document.getElementById('canvas');
const spinnerLdsElement = document.getElementById('spinner-lds');

const body = document.getElementById('body');
const isLoading = new CustomEvent('isLoading', { detail: { loading: true } });
const isNotLoading = new CustomEvent('isLoading', { detail: { loading: false } });

const VlcModuleExt = {
  preRun: [ function() {
    window.display_overlay = true
  }],
  vlc_access_file: {},
  // callHandler targets for frame routing
  vlcOnDecoderFrame: window._vlcOnDecoderFrame,
  vlcSetRenderPort1: window._vlcSetRenderPort1,
  onRuntimeInitialized: function() {},
  print: (() => {
    const element = document.getElementById('output');
    if (element) element.value = '';
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

  canvas: (function() {
    var canvas = document.getElementById('canvas')
    // var overlay = document.getElementById('overlay')
    // As a default initial behavior, pop up an alert when webgl context is lost. To make your
    // application robust, you may want to override this behavior before shipping!
    // See http://www.khronos.org/registry/webgl/specs/latest/1.0/#5.15.2
    canvas.addEventListener("webglcontextlost", function(e) {
      console.error('WebGL context lost. You will need to reload the page.');
      e.preventDefault();
    });
    return canvas;
  })(),
  setStatus: function(text) {
    if (!VlcModuleExt.setStatus.last) VlcModuleExt.setStatus.last = { time: Date.now(), text: '' };
    if (text === VlcModuleExt.setStatus.last.text) return;
    var m = text.match(/([^(]+)\((\d+(\.\d+)?)\/(\d+)\)/);
    var now = Date.now();
    if (m && now - VlcModuleExt.setStatus.last.time < 30) return; // if this is a progress update, skip it if too soon
    VlcModuleExt.setStatus.last.time = now;
    VlcModuleExt.setStatus.last.text = text;
    if (m) {
      text = m[1];
      body.dispatchEvent(isLoading);
    } else {
      body.dispatchEvent(isNotLoading);
    }
  },
  totalDependencies: 0,
  monitorRunDependencies: function(left) {
    this.totalDependencies = Math.max(this.totalDependencies, left);
    VlcModuleExt.setStatus(left ? 'Preparing... (' + (this.totalDependencies-left) + '/' + this.totalDependencies + ')' : 'All downloads complete.');
  }
};
