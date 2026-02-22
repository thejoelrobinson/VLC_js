/// <reference lib="webworker" />

// OffscreenCanvas render worker for VLC.js WebCodecs frames.
// Receives decoded VideoFrame objects via MessagePort and draws them
// to an OffscreenCanvas, keeping frame rendering off the main thread.

let ctx: OffscreenCanvasRenderingContext2D | null = null;

self.onmessage = function(e: MessageEvent): void {
  const data = e.data;
  if (data.type === 'init') {
    const offscreen: OffscreenCanvas = data.offscreen;
    const port: MessagePort = data.port;

    ctx = offscreen.getContext('2d');
    if (!ctx) {
      console.error('[render-worker] Failed to get 2D context from OffscreenCanvas');
      return;
    }

    port.onmessage = function(msg: MessageEvent): void {
      const frame: VideoFrame = msg.data.frame;
      if (ctx && frame) {
        ctx.drawImage(frame, 0, 0, ctx.canvas.width, ctx.canvas.height);
        frame.close();
      }
    };

    console.log('[render-worker] Initialized with OffscreenCanvas');
  }
};
