// Patch VideoDecoder.configure to handle bare 'avc1' codec strings.
// VLC's webcodec module may not have profile/level at configure() time when
// the MXF demuxer hasn't yet provided AVCC extradata. Bare 'avc1' is rejected
// by Chrome; use High Profile Level 4.0 as a safe fallback.
if (typeof VideoDecoder !== 'undefined') {
  const _OrigVideoDecoder = VideoDecoder;
  class PatchedVideoDecoder extends _OrigVideoDecoder {
    configure(config: VideoDecoderConfig): void {
      if (config && config.codec === 'avc1') {
        config = Object.assign({}, config, { codec: 'avc1.640028' });
        console.log('[webcodec] configure: bare avc1 -> avc1.640028 (High Profile fallback)');
      }
      return super.configure(config);
    }
  }
  // Preserve static methods
  PatchedVideoDecoder.isConfigSupported = _OrigVideoDecoder.isConfigSupported.bind(_OrigVideoDecoder);
  window.VideoDecoder = PatchedVideoDecoder as typeof VideoDecoder;
}

// vlcOnDecoderFrame: called on the MAIN THREAD via Emscripten's callHandler mechanism
// when the decoder worker has a decoded VideoFrame ready. This runs on the main thread
// (where Module.glConv is set by initGlConvWorker, since VLC's GL renderer runs on
// the main thread in this Emscripten pthreads build).
// The pictureId and frame are delivered directly here, bypassing MessagePort.
const _vlcPendingFrames: Record<number, VideoFrame> = {};
const _vlcFrameResolvers: Record<number, (frame: VideoFrame) => void> = {};
let _vlcRenderPort1: MessagePort | null = null;

window._vlcSetRenderPort1 = function(port1: MessagePort): void {
  _vlcRenderPort1 = port1;
  console.log('[webcodec] render MessageChannel port1 received on main thread');
};

// Direct canvas rendering: draw VideoFrame directly to the canvas using 2D context.
// This bypasses VLC's rendering pipeline (glinterop) entirely — VLC 4.0's WASM vout
// doesn't properly route VLC_CODEC_WEBCODEC_OPAQUE to the glinterop plugin.
// VideoFrame.drawToCanvas() / ctx.drawImage(frame) is the correct native approach.
let _vlcCanvas2d: CanvasRenderingContext2D | null = null;
function _vlcGetCanvas2d(): CanvasRenderingContext2D | null {
  if (_vlcCanvas2d) return _vlcCanvas2d;
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
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

window._vlcOnDecoderFrame = function(pictureId: number, frame: VideoFrame): void {
  // Update _vlcStateCache from VideoFrame timestamp so the overlay progress bar works.
  // VideoFrame.timestamp is in microseconds; convert to milliseconds.
  if (frame && frame instanceof VideoFrame && frame.timestamp != null) {
    if (!window._vlcStateCache) {
      window._vlcStateCache = { position: 0, timeMs: 0, lengthMs: 0, volume: 80, muted: false, chapter: -1, chapterCount: 0 };
    }
    window._vlcStateCache.timeMs = Math.round(frame.timestamp / 1000);
    if (window._vlcStateCache.lengthMs > 0) {
      window._vlcStateCache.position = window._vlcStateCache.timeMs / window._vlcStateCache.lengthMs;
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

window._vlcAwaitFrame = async function(pictureId: number): Promise<VideoFrame> {
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
var body = document.getElementById('body')!;
var isLoading = new CustomEvent('isLoading', { detail: { loading: true } });
var isNotLoading = new CustomEvent('isLoading', { detail: { loading: false } });

var VlcModuleExt: VlcModuleConfig = {
  preRun: [ function(): void {
    window.display_overlay = true;
  }],
  vlc_access_file: {},
  // callHandler targets for frame routing
  vlcOnDecoderFrame: window._vlcOnDecoderFrame,
  vlcSetRenderPort1: window._vlcSetRenderPort1,
  onRuntimeInitialized: function(): void {},
  print: ((): ((...args: unknown[]) => void) => {
    const element = document.getElementById('output') as HTMLTextAreaElement | null;
    if (element) element.value = '';
    return (...args: unknown[]): void => {
      const text = args.join(' ');
      console.log(text);
      if (element) {
        element.value += text + "\n";
        element.scrollTop = element.scrollHeight;
      }
    };
  })(),
  printErr: (...args: unknown[]): void => {
    const text = args.join(' ');
    console.error(text);
  },

  canvas: (function(): HTMLCanvasElement {
    const canvas = document.getElementById('canvas') as HTMLCanvasElement;
    canvas.addEventListener("webglcontextlost", function(e: Event): void {
      console.error('WebGL context lost. You will need to reload the page.');
      e.preventDefault();
    });
    return canvas;
  })(),

  setStatus: function(text: string): void {
    const last = VlcModuleExt.setStatus as typeof VlcModuleExt.setStatus & { last?: { time: number; text: string } };
    if (!last.last) last.last = { time: Date.now(), text: '' };
    if (text === last.last.text) return;
    const m = text.match(/([^(]+)\((\d+(\.\d+)?)\/(\d+)\)/);
    const now = Date.now();
    if (m && now - last.last.time < 30) return;
    last.last.time = now;
    last.last.text = text;
    if (m) {
      body.dispatchEvent(isLoading);
    } else {
      body.dispatchEvent(isNotLoading);
    }
  },
  totalDependencies: 0,
  monitorRunDependencies: function(left: number): void {
    this.totalDependencies = Math.max(this.totalDependencies, left);
    VlcModuleExt.setStatus(left ? 'Preparing... (' + (this.totalDependencies - left) + '/' + this.totalDependencies + ')' : 'All downloads complete.');
  }
};

// OffscreenCanvas render worker setup — moves VideoFrame drawing off the main thread.
// Guarded by feature detection: requires Worker + OffscreenCanvas + transferControlToOffscreen.
function _initRenderWorker(): void {
  if (typeof Worker === 'undefined') return;
  if (!('transferControlToOffscreen' in HTMLCanvasElement.prototype)) return;

  const mainCanvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  if (!mainCanvas) return;

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
  let offscreen: OffscreenCanvas;
  try {
    offscreen = overlay.transferControlToOffscreen();
  } catch (e) {
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

    worker.onerror = function(e: ErrorEvent): void {
      console.warn('[webcodec] render worker error, falling back to main-thread rendering:', e);
      _vlcRenderPort1 = null;
    };

    console.log('[webcodec] OffscreenCanvas render worker started');
  } catch (e) {
    console.warn('[webcodec] Failed to start render worker, using main-thread rendering:', e);
  }
}

// Attempt eager OffscreenCanvas setup once DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initRenderWorker);
} else {
  _initRenderWorker();
}
