"use strict";
/// <reference lib="webworker" />
// OffscreenCanvas render worker for VLC.js WebCodecs frames.
// Receives decoded VideoFrame objects via MessagePort and draws them
// to an OffscreenCanvas, keeping frame rendering off the main thread.
let ctx = null;
self.onmessage = function (e) {
    const data = e.data;
    if (data.type === 'init') {
        const offscreen = data.offscreen;
        const port = data.port;
        ctx = offscreen.getContext('2d');
        if (!ctx) {
            console.error('[render-worker] Failed to get 2D context from OffscreenCanvas');
            return;
        }
        port.onmessage = function (msg) {
            const frame = msg.data.frame;
            if (ctx && frame) {
                ctx.drawImage(frame, 0, 0, ctx.canvas.width, ctx.canvas.height);
                frame.close();
            }
        };
        console.log('[render-worker] Initialized with OffscreenCanvas');
    }
};
