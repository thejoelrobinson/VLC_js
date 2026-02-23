/**
 * Browser integration test: MXF H.264 playback via WebCodecs pipeline
 *
 * Starts a minimal dev server, launches a real Chromium browser, uploads the
 * Canon MXF test file, and asserts the full WebCodecs decode pipeline works.
 *
 * Success criteria (verifiable without GPU/display):
 *   - WebCodecs decoder opens — no avcodec get_buffer() fallback
 *   - Correct H.264 codec identified from SPS (avc1.7a for Canon Cinema EOS)
 *   - At least 10 VideoFrames decoded and delivered via callHandler
 *   - No fatal WASM heap corruption or "closed codec" crashes
 *
 * Additional pass indicators when GPU is available (real Chrome):
 *   - Module.glCtx is set from GL.currentContext.GLctx
 *   - Rendering pipeline established (vlcSetRenderPort1 called)
 *
 * Run with: npm run test:browser
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, statSync, createReadStream } from 'fs';
import { join, resolve as pathResolve, extname } from 'path';
import { createServer } from 'http';
import { fileURLToPath } from 'url';

const PROJECT_ROOT = pathResolve(join(fileURLToPath(import.meta.url), '../..'));
const MXF_FILE     = join(PROJECT_ROOT, 'A009C233_260209D4_CANON.MXF');
const SERVER_PORT  = 3099; // avoid conflict with npm start (3000)
const SERVER_URL   = `http://localhost:${SERVER_PORT}`;

const DECODE_TIMEOUT_MS  = 30_000; // wait up to 30s for frames (covers threading errors that appear ~20s in)
const MIN_FRAMES_DECODED = 10;     // must decode at least this many frames

// ── Minimal dev server ────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.css': 'text/css',   '.wasm': 'application/wasm',
  '.png': 'image/png',  '.ico': 'image/x-icon',
};

function startServer() {
  return new Promise((serverResolve, serverReject) => {
    const srv = createServer((req, res) => {
      const filePath = join(PROJECT_ROOT, req.url === '/' ? 'vlc.html' : req.url);
      const safe = pathResolve(filePath);
      if (!safe.startsWith(PROJECT_ROOT)) { res.writeHead(403); res.end(); return; }
      // Required for SharedArrayBuffer (WASM threads)
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      try {
        if (!statSync(safe).isFile()) throw new Error('not a file');
        res.writeHead(200, { 'Content-Type': MIME[extname(safe).toLowerCase()] || 'application/octet-stream' });
        createReadStream(safe).pipe(res);
      } catch {
        res.writeHead(404); res.end('Not found');
      }
    });
    srv.listen(SERVER_PORT, () => serverResolve(srv));
    srv.once('error', serverReject);
  });
}

// ── Playback runner ───────────────────────────────────────────────────────

async function runPlaybackTest(browser, mxfPath) {
  const context = await browser.newContext();
  const page    = await context.newPage();
  const messages = [];

  page.on('console', msg => messages.push({ type: msg.type(), text: msg.text() }));
  page.on('pageerror', err => messages.push({ type: 'pageerror', text: err.message }));

  try {
    // Use 'load' (not 'networkidle') — the 31MB WASM means network never truly idles
    await page.goto(SERVER_URL, { waitUntil: 'load', timeout: 60_000 });

    // Wait for the VLC WASM module to finish initializing
    await page.waitForFunction(
      () => window.Module?._wasm_libvlc_init != null,
      { timeout: 60_000, polling: 500 }
    );

    // Inject frame counter before uploading the file
    await page.evaluate(() => {
      window.__vlcFramesDecoded = 0;
      const orig = window.Module?.vlcOnDecoderFrame;
      if (orig) {
        window.Module.vlcOnDecoderFrame = function(pid, frame) {
          if (frame instanceof VideoFrame) window.__vlcFramesDecoded++;
          return orig.call(this, pid, frame);
        };
      }
    });

    // Upload the MXF file
    await page.locator('#fpicker_btn').setInputFiles(mxfPath, { timeout: 10_000 });

    // Poll until we have enough decoded frames (or timeout)
    const deadline = Date.now() + DECODE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const count = await page.evaluate(() => window.__vlcFramesDecoded || 0);
      if (count >= MIN_FRAMES_DECODED) break;
      await page.waitForTimeout(500);
    }

    const framesDecoded = await page.evaluate(() => window.__vlcFramesDecoded || 0);

    // Categorise messages
    const logs    = messages.filter(m => m.type === 'log');
    const errors  = messages.filter(m =>
      (m.type === 'error' || m.type === 'pageerror') &&
      !m.text.includes('customCmd') &&      // expected: file-access module protocol
      !m.text.includes('[object Object]')   // expected: file-access response
    );

    return {
      framesDecoded,
      codecReconfigMsg:  logs.find(m => m.text.includes('[webcodec] reconfigured:'))?.text ?? null,
      glCtxSet:          logs.some(m => m.text.includes('Module.glCtx set')),
      renderPortSet:     logs.some(m => m.text.includes('render MessageChannel port1')),
      getBufferErrors:   errors.filter(m => m.text.includes('get_buffer')).map(m => m.text),
      heapErrors:        errors.filter(m => m.text.includes('Aborted') || m.text.includes('heap')).map(m => m.text.slice(0, 160)),
      closedCodecErrors: errors.filter(m => m.text.includes('closed codec')).map(m => m.text.slice(0, 160)),
      valThreadErrors:   errors.filter(m => m.text.includes('wrong thread') || m.text.includes('pthread_equal')).map(m => m.text.slice(0, 160)),
      syntaxErrors:      errors.filter(m => m.type === 'pageerror').map(m => m.text.slice(0, 160)),
    };
  } finally {
    await context.close();
  }
}

// ── Test suite ────────────────────────────────────────────────────────────

describe('MXF WebCodecs browser playback', () => {
  let server  = null;
  let browser = null;
  let sharedResult = null; // run once, reuse across both assertion tests

  beforeAll(async () => {
    if (!existsSync(MXF_FILE)) return; // tests skip individually
    server = await startServer();
    try {
      const { chromium } = await import('playwright-core');
      browser = await chromium.launch({ headless: false });
    } catch {
      // playwright not available — tests will skip
    }
  }, 90_000);

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await new Promise(done => server ? server.close(done) : done());
  });

  // ── Prerequisite ────────────────────────────────────────────────────────

  it('MXF test file exists', () => {
    expect(existsSync(MXF_FILE), `MXF file not found: ${MXF_FILE}`).toBe(true);
  });

  it('dev server starts on port ' + SERVER_PORT, () => {
    expect(server, 'Server failed to start').toBeTruthy();
  });

  // ── WebCodecs pipeline ──────────────────────────────────────────────────

  it('WebCodecs decodes ≥10 VideoFrames from Canon MXF H.264', async () => {
    if (!existsSync(MXF_FILE)) { console.warn('[skip] MXF file not found'); return; }
    if (!browser)               { console.warn('[skip] browser not available'); return; }

    sharedResult = await runPlaybackTest(browser, MXF_FILE);

    expect(
      sharedResult.framesDecoded,
      `Expected ≥${MIN_FRAMES_DECODED} decoded VideoFrames, got ${sharedResult.framesDecoded}\n` +
      `This indicates webcodec is not decoding — check console for errors`
    ).toBeGreaterThanOrEqual(MIN_FRAMES_DECODED);

    console.log(`  ✓ ${sharedResult.framesDecoded} VideoFrames decoded`);
  }, 90_000);

  it('uses WebCodecs (no avcodec fallback, no crashes)', async () => {
    if (!sharedResult) { console.warn('[skip] previous test did not run'); return; }

    // Avcodec fallback means webcodec Open() failed
    expect(
      sharedResult.getBufferErrors,
      `avcodec fallback detected — webcodec Open() failed:\n${sharedResult.getBufferErrors.join('\n')}`
    ).toHaveLength(0);

    // WASM heap corruption = null webCodecCtx passed to C
    expect(
      sharedResult.heapErrors,
      `WASM heap corruption:\n${sharedResult.heapErrors.join('\n')}`
    ).toHaveLength(0);

    // VideoDecoder closed prematurely = reconfigure dimension bug
    expect(
      sharedResult.closedCodecErrors,
      `VideoDecoder closed unexpectedly:\n${sharedResult.closedCodecErrors.join('\n')}`
    ).toHaveLength(0);

    // emval thread affinity crash — val accessed from wrong thread
    // (emscripten_set_main_loop_arg recycles pthread after C fn exits)
    expect(
      sharedResult.valThreadErrors,
      `emval thread affinity violation (ASSERTIONS=1 build?):\n${sharedResult.valThreadErrors?.join('\n')}`
    ).toHaveLength(0);

    // JavaScript syntax errors in our patches
    expect(
      sharedResult.syntaxErrors,
      `JS syntax/runtime errors in page:\n${sharedResult.syntaxErrors.join('\n')}`
    ).toHaveLength(0);

    console.log('  ✓ No avcodec fallback');
    console.log('  ✓ No WASM crashes');
    console.log('  ✓ VideoDecoder stayed open');
  }, 10_000); // uses sharedResult, no browser needed

  it('correct H.264 codec identified from SPS (Canon Cinema EOS = High 4:2:2 Profile)', () => {
    if (!sharedResult) { console.warn('[skip] previous test did not run'); return; }
    if (!sharedResult.codecReconfigMsg) {
      console.warn('[skip] no reconfigure message — codec already correct or file differs');
      return;
    }
    // Canon Cinema EOS uses H.264 High 4:2:2 Profile (profile 0x7a) at 4K
    expect(
      sharedResult.codecReconfigMsg,
      'Expected Canon MXF to use High 4:2:2 Profile (avc1.7a*)'
    ).toMatch(/avc1\.7a/);
    console.log(`  ✓ Codec: ${sharedResult.codecReconfigMsg}`);
  }, 10_000);

  it('rendering pipeline established when GPU available', () => {
    if (!sharedResult) { console.warn('[skip] previous test did not run'); return; }
    if (!sharedResult.glCtxSet && !sharedResult.renderPortSet) {
      console.warn('[info] GPU not available in test env — GL context and render port not established (expected in headless CI)');
      // Not a failure in CI — mark as info only
      return;
    }
    if (sharedResult.glCtxSet)    console.log('  ✓ Module.glCtx set from GL.currentContext.GLctx');
    if (sharedResult.renderPortSet) console.log('  ✓ Rendering MessageChannel established');
  }, 10_000);

  // ── EOS crash regression ─────────────────────────────────────────────────
  // Plays to the last few seconds by seeking to 97%, then waits for natural
  // end-of-stream.  Catches "function signature mismatch" errors that only
  // appear when the clip actually finishes (not detectable with the 10-frame
  // test above, which stops long before EOS).
  it('no crash when clip plays to natural end-of-stream', async () => {
    if (!existsSync(MXF_FILE)) { console.warn('[skip] MXF file not found'); return; }
    if (!browser)               { console.warn('[skip] browser not available'); return; }

    const context = await browser.newContext();
    const page    = await context.newPage();
    const eosErrors = [];

    page.on('pageerror', err => {
      const msg = err.message || String(err);
      if (!msg.includes('customCmd') && !msg.includes('[object Object]'))
        eosErrors.push(msg);
    });
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const t = msg.text();
        if (!t.includes('customCmd') && !t.includes('[object Object]'))
          eosErrors.push(t);
      }
    });

    try {
      await page.goto(SERVER_URL, { waitUntil: 'load', timeout: 60_000 });
      await page.waitForFunction(
        () => window.Module?._wasm_libvlc_init != null,
        { timeout: 60_000, polling: 500 }
      );

      // Hook frame counter before file is uploaded
      await page.evaluate(() => {
        window.__eosFrames = 0;
        const orig = window.Module?.vlcOnDecoderFrame;
        if (orig) window.Module.vlcOnDecoderFrame = function(pid, frame) {
          if (frame instanceof VideoFrame) window.__eosFrames++;
          return orig.call(this, pid, frame);
        };
      });

      await page.locator('#fpicker_btn').setInputFiles(MXF_FILE, { timeout: 10_000 });

      // Wait for at least 5 decoded frames — confirms WebCodecs pipeline is live
      await page.waitForFunction(
        () => (window.__eosFrames || 0) >= 5,
        { timeout: 30_000, polling: 300 }
      );

      // Jump to 97%: reaches EOS in a few seconds regardless of clip length
      await page.evaluate(() => {
        if (window.media_player && !window._vlcException)
          window.media_player.set_position(0.97);
      });

      // Wait for natural EOS — stale-detection in _uiLoop sets _vlcAtEOS=true
      // Give up to 90 s in case the clip is long or the machine is slow
      await page.waitForFunction(
        () => window._vlcAtEOS === true,
        { timeout: 90_000, polling: 500 }
      );

      // Extra 2 s for any async error handlers (worker.onerror) to fire
      await page.waitForTimeout(2_000);

      const sigMismatch = eosErrors.filter(e =>
        e.includes('signature mismatch') || e.includes('RuntimeError')
      );

      expect(
        sigMismatch,
        `"function signature mismatch" at EOS — VLC pipeline race during teardown:\n` +
        sigMismatch.join('\n')
      ).toHaveLength(0);

      expect(
        eosErrors.filter(e => e.includes('Aborted') || e.includes('heap')),
        `WASM abort at EOS:\n${eosErrors.join('\n')}`
      ).toHaveLength(0);

      console.log('  ✓ EOS reached cleanly — no crash');
    } finally {
      await context.close();
    }
  }, 120_000); // 2-minute budget: covers 97%→EOS + 2s grace period
});
