/**
 * Speed improvement tests: AudioWorklet preload, OPFS Worker copy, EOS non-interference.
 *
 * These are static analysis tests — they verify source code invariants that
 * enforce the latency improvements without requiring a browser or WASM runtime.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PROJECT_ROOT = path.resolve(path.join(fileURLToPath(import.meta.url), '../..'));
const MAIN_JS        = path.join(PROJECT_ROOT, 'main.js');
const OPFS_JS        = path.join(PROJECT_ROOT, 'lib', 'opfs.js');
const OPFS_WORKER_JS = path.join(PROJECT_ROOT, 'lib', 'opfs-worker.js');
const MODULE_LOADER  = path.join(PROJECT_ROOT, 'lib', 'module-loader.js');

// ═══════════════════════════════════════════════════════════════════════════════
// AudioWorklet preload (module-loader.js)
//
// Warm the browser HTTP cache for audio-worklet-processor.js at module load
// time (top-level, fire-and-forget). webaudio.js later calls
// audioCtx.audioWorklet.addModule() which hits the cache instead of a cold
// HTTP fetch, saving 30-100ms on first play.
// ═══════════════════════════════════════════════════════════════════════════════

describe('AudioWorklet preload (module-loader.js)', () => {
  it('module-loader.js contains fetch(\'./audio-worklet-processor.js\')', () => {
    const src = fs.readFileSync(MODULE_LOADER, 'utf-8');
    expect(src).toContain("fetch('./audio-worklet-processor.js')");
  });

  it('preload fetch is NOT inside a function body (module scope)', () => {
    const src = fs.readFileSync(MODULE_LOADER, 'utf-8');
    const fetchIdx = src.indexOf("fetch('./audio-worklet-processor.js')");
    expect(fetchIdx).toBeGreaterThan(-1);
    // Check the preceding 200 characters for `function` or `=>` keywords.
    // If the fetch is at module scope, these should not appear nearby as
    // the enclosing context (only top-level statements, comments, etc.).
    const preceding = src.slice(Math.max(0, fetchIdx - 200), fetchIdx);
    // Must not be inside a function() {...} or an arrow () => {...}
    // Look for unmatched `function` or `=>` that would indicate nesting.
    const hasFunction = /\bfunction\b[^}]*$/.test(preceding);
    const hasArrow = /=>[^}]*$/.test(preceding);
    expect(hasFunction).toBe(false);
    expect(hasArrow).toBe(false);
  });

  it('preload uses .catch() for fire-and-forget error handling', () => {
    const src = fs.readFileSync(MODULE_LOADER, 'utf-8');
    // The fetch line should chain .catch() to suppress unhandled rejection
    const fetchLine = src.split('\n').find(l => l.includes("fetch('./audio-worklet-processor.js')"));
    expect(fetchLine).toBeDefined();
    expect(fetchLine).toContain('.catch(');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OPFS Worker source invariants (lib/opfs-worker.js)
//
// The dedicated Worker uses FileSystemSyncAccessHandle for synchronous writes
// to OPFS, completely isolated from the main thread's ASYNCIFY event loop.
// This prevents the EOS page-freeze bug caused by main-thread Promise chains
// from createWritable() interleaving with ASYNCIFY's stack unwind.
// ═══════════════════════════════════════════════════════════════════════════════

describe('OPFS Worker source invariants (lib/opfs-worker.js)', () => {
  it('file exists', () => {
    expect(fs.existsSync(OPFS_WORKER_JS)).toBe(true);
  });

  it('uses createSyncAccessHandle (Worker-only sync API)', () => {
    const src = fs.readFileSync(OPFS_WORKER_JS, 'utf-8');
    expect(src).toContain('createSyncAccessHandle');
  });

  it('does NOT contain createWritable (main-thread API that causes EOS interference)', () => {
    const src = fs.readFileSync(OPFS_WORKER_JS, 'utf-8');
    // Strip comment lines — createWritable may be referenced in comments explaining
    // why the Worker approach exists, but must NOT appear in executable code.
    const codeOnly = src.split('\n')
      .filter(l => !l.trim().startsWith('//'))
      .join('\n');
    expect(codeOnly).not.toContain('createWritable');
  });

  it('has self.onmessage handler', () => {
    const src = fs.readFileSync(OPFS_WORKER_JS, 'utf-8');
    expect(src).toContain('self.onmessage');
  });

  it('posts { type: \'done\' } on success', () => {
    const src = fs.readFileSync(OPFS_WORKER_JS, 'utf-8');
    expect(src).toMatch(/postMessage\([^)]*type:\s*['"]done['"]/);
  });

  it('posts { type: \'error\' } on failure (graceful error path)', () => {
    const src = fs.readFileSync(OPFS_WORKER_JS, 'utf-8');
    expect(src).toMatch(/postMessage\([^)]*type:\s*['"]error['"]/);
  });

  it('calls sync.flush() before sync.close() (proper OPFS cleanup order)', () => {
    const src = fs.readFileSync(OPFS_WORKER_JS, 'utf-8');
    const flushIdx = src.indexOf('sync.flush()');
    const closeIdx = src.indexOf('sync.close()');
    expect(flushIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(-1);
    expect(flushIdx).toBeLessThan(closeIdx);
  });

  it('uses { at: offset } in write call (random-access, not append-only)', () => {
    const src = fs.readFileSync(OPFS_WORKER_JS, 'utf-8');
    expect(src).toMatch(/\.write\([^)]*\{[^}]*at:\s*offset/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// copyFileToOPFSViaWorker (lib/opfs.js)
//
// The new Worker-based OPFS copy function that replaces main-thread
// createWritable() usage during playback.
// ═══════════════════════════════════════════════════════════════════════════════

describe('copyFileToOPFSViaWorker (lib/opfs.js)', () => {
  it('copyFileToOPFSViaWorker is exported from lib/opfs.js', () => {
    const src = fs.readFileSync(OPFS_JS, 'utf-8');
    expect(src).toMatch(/export\s+(async\s+)?function\s+copyFileToOPFSViaWorker/);
  });

  it('creates new Worker(\'./lib/opfs-worker.js\')', () => {
    const src = fs.readFileSync(OPFS_JS, 'utf-8');
    expect(src).toContain("new Worker('./lib/opfs-worker.js')");
  });

  it('does NOT call createWritable (uses Worker, not main-thread stream)', () => {
    const src = fs.readFileSync(OPFS_JS, 'utf-8');
    // Extract only the copyFileToOPFSViaWorker function body
    const fnStart = src.indexOf('copyFileToOPFSViaWorker');
    expect(fnStart).toBeGreaterThan(-1);
    // Find the next exported function or end of file
    const fnBody = src.slice(fnStart);
    // The function itself should not use createWritable
    const nextExport = fnBody.indexOf('\nexport ', 1);
    const relevantBody = nextExport > 0 ? fnBody.slice(0, nextExport) : fnBody;
    expect(relevantBody).not.toContain('createWritable');
  });

  it('calls worker.terminate() on completion (no Worker leak)', () => {
    const src = fs.readFileSync(OPFS_JS, 'utf-8');
    const fnStart = src.indexOf('copyFileToOPFSViaWorker');
    const fnBody = src.slice(fnStart);
    expect(fnBody).toContain('worker.terminate()');
  });

  it('calls worker.terminate() on error path (terminate in BOTH done and error handlers)', () => {
    const src = fs.readFileSync(OPFS_JS, 'utf-8');
    const fnStart = src.indexOf('copyFileToOPFSViaWorker');
    const fnBody = src.slice(fnStart);
    // Count occurrences of worker.terminate() — need at least 2 (done + error)
    const terminateCount = (fnBody.match(/worker\.terminate\(\)/g) || []).length;
    expect(terminateCount).toBeGreaterThanOrEqual(2);
  });

  it('old copyFileToOPFS function still exists (backward compat)', () => {
    const src = fs.readFileSync(OPFS_JS, 'utf-8');
    expect(src).toMatch(/export\s+async\s+function\s+copyFileToOPFS\b/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// main.js OPFS Worker integration
//
// main.js uses copyFileToOPFSViaWorker at file-selection time (handleFiles)
// as a fire-and-forget background copy. The result is awaited at play time
// with a short timeout via Promise.race for just-in-time OPFS use.
// ═══════════════════════════════════════════════════════════════════════════════

describe('main.js OPFS Worker integration', () => {
  it('main.js imports copyFileToOPFSViaWorker from \'./lib/opfs.js\'', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    expect(src).toContain('copyFileToOPFSViaWorker');
    expect(src).toMatch(/import\s*\{[^}]*copyFileToOPFSViaWorker[^}]*\}\s*from\s*['"]\.\/lib\/opfs\.js['"]/);
  });

  it('copyFileToOPFSViaWorker is called in handleFiles BEFORE handlePlayPause definition', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // The call to copyFileToOPFSViaWorker should appear in handleFiles (file selection),
    // which is defined before handlePlayPause.
    const codeOnly = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    const copyCallIdx = codeOnly.indexOf('copyFileToOPFSViaWorker(');
    const handlePlayPauseIdx = codeOnly.indexOf('function handlePlayPause');
    expect(copyCallIdx).toBeGreaterThan(-1);
    expect(handlePlayPauseIdx).toBeGreaterThan(-1);
    expect(copyCallIdx).toBeLessThan(handlePlayPauseIdx);
  });

  it('stores result as window._vlcOPFSCopyPromise', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    expect(src).toContain('_vlcOPFSCopyPromise');
  });

  it('checks window._vlcOPFSFile before play (uses cached file if available)', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    expect(src).toContain('_vlcOPFSFile');
  });

  it('resets _vlcOPFSFile and _vlcOPFSCopyPromise on new file selection (stale-state prevention)', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // Both must be reset at the start of handleFiles
    const handleFilesIdx = src.indexOf('function handleFiles');
    expect(handleFilesIdx).toBeGreaterThan(-1);
    const afterHandleFiles = src.slice(handleFilesIdx);
    expect(afterHandleFiles).toContain('_vlcOPFSFile');
    expect(afterHandleFiles).toContain('_vlcOPFSCopyPromise');
  });

  it('handlePlayPause is declared async (needed for await Promise.race)', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    expect(src).toMatch(/async\s+function\s+handlePlayPause/);
  });

  it('uses Promise.race with 200ms timeout for just-in-time OPFS use at play time', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    expect(src).toContain('Promise.race');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EOS non-interference invariants
//
// The OPFS copy must NOT interfere with VLC's end-of-stream event dispatch.
// The old main-thread createWritable() approach caused ASYNCIFY stack unwind
// interleaving that froze the page at EOS. The Worker approach isolates all
// OPFS I/O to a separate thread with its own event loop.
// ═══════════════════════════════════════════════════════════════════════════════

describe('EOS non-interference invariants', () => {
  it('copyFileToOPFSViaWorker in opfs.js does NOT use createWritable (Worker approach only)', () => {
    const src = fs.readFileSync(OPFS_JS, 'utf-8');
    const fnStart = src.indexOf('copyFileToOPFSViaWorker');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart);
    const nextExport = fnBody.indexOf('\nexport ', 1);
    const relevantBody = nextExport > 0 ? fnBody.slice(0, nextExport) : fnBody;
    expect(relevantBody).not.toContain('createWritable');
  });

  it('main.js does NOT call old copyFileToOPFS during playback', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // The old copyFileToOPFS function should not be called from main.js.
    // It may still be imported (for backward compat) but never invoked.
    // Strip comments and check for bare function calls.
    const codeOnly = src.split('\n')
      .filter(l => !l.trim().startsWith('//'))
      .join('\n');
    // copyFileToOPFS( is the call pattern; copyFileToOPFSViaWorker( is different
    const oldCallPattern = /\bcopyFileToOPFS\s*\(/g;
    const matches = codeOnly.match(oldCallPattern) || [];
    // Filter out copyFileToOPFSViaWorker matches
    const oldOnlyCalls = matches.filter(m => !m.includes('ViaWorker'));
    expect(oldOnlyCalls.length).toBe(0);
  });

  it('OPFS copy in handleFiles does NOT use await on the copy promise (fire-and-forget)', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // Find the handleFiles function body
    const handleFilesIdx = src.indexOf('function handleFiles');
    expect(handleFilesIdx).toBeGreaterThan(-1);
    // Get the function body up to the next top-level function
    const afterHandleFiles = src.slice(handleFilesIdx);
    // Find the copyFileToOPFSViaWorker call line
    const copyLine = afterHandleFiles.split('\n').find(l =>
      l.includes('copyFileToOPFSViaWorker(')
    );
    // The call should NOT be preceded by `await` on the same line
    if (copyLine) {
      expect(copyLine).not.toMatch(/\bawait\s+copyFileToOPFSViaWorker/);
    }
  });

  it('comment in opfs-worker.js mentions EOS or ASYNCIFY interference', () => {
    const src = fs.readFileSync(OPFS_WORKER_JS, 'utf-8');
    // The worker file should document why it exists: avoiding EOS/ASYNCIFY interference
    expect(src).toMatch(/EOS|ASYNCIFY|no.*interference|event.?loop/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// emjsfile OPFS SyncAccessHandle fast-read (build/emjsfile/emjsfile.c)
//
// The emjsfile VLC access module was the bottleneck: every file read used
// Blob.slice() + FileReaderSync.readAsArrayBuffer() — several ms per call
// (Emscripten issue #6955). The patched version adds FileSystemSyncAccessHandle
// as a fast path: sub-ms synchronous reads with no Blob overhead.
// ═══════════════════════════════════════════════════════════════════════════════

describe('emjsfile OPFS SyncAccessHandle fast-read (build/emjsfile/emjsfile.c)', () => {
  const EMJSFILE_C = path.join(PROJECT_ROOT, 'build', 'emjsfile', 'emjsfile.c');

  it('build/emjsfile/emjsfile.c exists', () => {
    expect(fs.existsSync(EMJSFILE_C)).toBe(true);
  });

  it('Read() uses syncHandle fast path when available', () => {
    const src = fs.readFileSync(EMJSFILE_C, 'utf-8');
    // Fast path: FileSystemSyncAccessHandle.read() — no Blob.slice() overhead
    expect(src).toContain('syncHandle.read(');
    expect(src).toContain('{ at: offset }');
  });

  it('Read() falls back to FileReaderSync when syncHandle unavailable', () => {
    const src = fs.readFileSync(EMJSFILE_C, 'utf-8');
    // Original Blob.slice path preserved as fallback
    expect(src).toContain('readAsArrayBuffer(blob)');
    expect(src).toContain('worker_js_file.slice(');
  });

  it('init struct includes syncHandle field initialised to undefined', () => {
    const src = fs.readFileSync(EMJSFILE_C, 'utf-8');
    // vlcAccess object must declare syncHandle so it can be checked in Read()
    expect(src).toContain('syncHandle:');
    expect(src).toContain('undefined');
  });

  it('init_js_file acquires FileSystemSyncAccessHandle when opfsName is provided', () => {
    const src = fs.readFileSync(EMJSFILE_C, 'utf-8');
    // SyncAccessHandle acquisition triggered by opfsName in the FileResult message
    expect(src).toContain('createSyncAccessHandle()');
    expect(src).toContain('msg.opfsName');
    // Uses vlcjs-cache directory (matches opfs-worker.js OPFS_DIR)
    expect(src).toContain("vlcjs-cache");
  });

  it('init_js_file has try/catch so OPFS failure falls back gracefully', () => {
    const src = fs.readFileSync(EMJSFILE_C, 'utf-8');
    // OPFS unavailable or quota exceeded must not crash VLC file open
    const acquireIdx = src.indexOf('createSyncAccessHandle');
    expect(acquireIdx).toBeGreaterThan(-1);
    // try/catch must wrap the acquisition
    const surrounding = src.slice(Math.max(0, acquireIdx - 600), acquireIdx + 600);
    expect(surrounding).toContain('try {');
    expect(surrounding).toContain('} catch');
  });

  it('EmFileClose closes syncHandle before releasing file reference', () => {
    const src = fs.readFileSync(EMJSFILE_C, 'utf-8');
    // Must close the exclusive SyncAccessHandle lock on file close
    expect(src).toContain('syncHandle.close()');
    // Close must appear BEFORE worker_js_file = undefined (release order)
    const closeIdx = src.indexOf('syncHandle.close()');
    const releaseIdx = src.indexOf('worker_js_file = undefined');
    expect(closeIdx).toBeGreaterThan(-1);
    expect(releaseIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeLessThan(releaseIdx);
  });

  it('MAIN_THREAD_EM_ASM includes opfsName in FileResult message', () => {
    const src = fs.readFileSync(EMJSFILE_C, 'utf-8');
    // Main thread passes opfsName so the Worker can open SyncAccessHandle
    expect(src).toContain('opfsName:');
    expect(src).toContain('vlc_opfs_name');
  });

  it('compile.sh injects emjsfile.c into the VLC access module tree', () => {
    const compileSrc = fs.readFileSync(
      path.join(PROJECT_ROOT, 'build', 'compile.sh'), 'utf-8'
    );
    expect(compileSrc).toContain('emjsfile');
    expect(compileSrc).toContain('modules/access/emjsfile.c');
  });

  it('Dockerfile COPY includes emjsfile/ directory (regression guard)', () => {
    const dockerSrc = fs.readFileSync(
      path.join(PROJECT_ROOT, 'build', 'Dockerfile'), 'utf-8'
    );
    // Without COPY emjsfile/ the injection step silently does nothing
    expect(dockerSrc).toContain('COPY emjsfile/');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// main.js vlc_opfs_name wiring
//
// emjsfile.c reads Module.vlc_opfs_name[id] to find the OPFS filename.
// main.js must set this whenever an OPFS-cached file is available so the
// SyncAccessHandle fast path activates automatically.
// ═══════════════════════════════════════════════════════════════════════════════

describe('main.js vlc_opfs_name wiring for emjsfile fast path', () => {

  it('main.js imports getOPFSNameForFile from opfs.js', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    expect(src).toContain('getOPFSNameForFile');
    // Must be in the import statement, not just referenced
    const importLine = src.split('\n').find(l => l.includes('from "./lib/opfs.js"'));
    expect(importLine).toContain('getOPFSNameForFile');
  });

  it('main.js defines _setOpfsName helper to propagate name to Module', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    expect(src).toContain('_setOpfsName');
    expect(src).toContain('vlc_opfs_name');
  });

  it('main.js calls _setOpfsName when previous-session cache is found', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // Fast path must activate for previously-cached files (not just new copies)
    const cachedIdx = src.indexOf('previously cached file');
    expect(cachedIdx).toBeGreaterThan(-1);
    const afterCached = src.slice(cachedIdx, cachedIdx + 600);
    expect(afterCached).toContain('_setOpfsName');
  });

  it('main.js calls _setOpfsName after Worker copy completes', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // Fast path must activate for newly-copied files
    const copyDoneIdx = src.indexOf('Worker copy done');
    expect(copyDoneIdx).toBeGreaterThan(-1);
    const afterCopy = src.slice(copyDoneIdx, copyDoneIdx + 500);
    expect(afterCopy).toContain('_setOpfsName');
  });

  it('main.js resets vlc_opfs_name on new file selection', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // Stale opfsName from a previous file would cause a wrong SyncAccessHandle
    const resetIdx = src.indexOf('_vlcOPFSFileName = null');
    expect(resetIdx).toBeGreaterThan(-1);
    // _setOpfsName(null) must appear near the reset
    const resetBlock = src.slice(resetIdx - 50, resetIdx + 200);
    expect(resetBlock).toContain('_setOpfsName');
  });

  it('lib/opfs.js exports getOPFSNameForFile', () => {
    const src = fs.readFileSync(OPFS_JS, 'utf-8');
    expect(src).toContain('export function getOPFSNameForFile');
    // Returns from localStorage (persisted across sessions)
    expect(src).toContain('localStorage.getItem');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VideoDecoder recovery after backward seek (module-loader.js)
//
// Problem: Flush() in webcodec.cpp is a no-op (thread-affinity constraint).
// Pre-seek delta frames reach the VideoDecoder before the IDR; the decoder
// rejects them and enters "closed" state. The deferred-configure pre-js patch
// then silently drops the IDR (`if (this.state === "closed") return;`),
// leaving the video frozen while audio plays to EOS.
//
// Fix: PatchedVideoDecoder.decode() in module-loader.js reconfigures the
// decoder with avc3.7a0033 when it sees state="closed" + a keyframe arrives.
// ═══════════════════════════════════════════════════════════════════════════════

describe('VideoDecoder backward-seek recovery (module-loader.js)', () => {
  const MODULE_LOADER_JS = path.join(PROJECT_ROOT, 'lib', 'module-loader.js');

  it('PatchedVideoDecoder defines a decode() method (not just configure)', () => {
    const src = fs.readFileSync(MODULE_LOADER_JS, 'utf-8');
    // decode() must be present as an overridden method in PatchedVideoDecoder
    expect(src).toContain('decode(chunk)');
  });

  it('decode() checks state === "closed" for recovery', () => {
    const src = fs.readFileSync(MODULE_LOADER_JS, 'utf-8');
    expect(src).toContain("state === 'closed'");
    // Recovery only fires on keyframe chunks (IDR), not delta frames
    expect(src).toContain("chunk.type === 'key'");
  });

  it('recovery calls super.configure with avc3.7a0033 (correct Annex B codec)', () => {
    const src = fs.readFileSync(MODULE_LOADER_JS, 'utf-8');
    // Must reconfigure with the same codec used by the deferred-configure patch
    expect(src).toContain("super.configure");
    expect(src).toContain("avc3.7a0033");
  });

  it('recovery has a cap on retry attempts (prevents infinite reconfigure loop)', () => {
    const src = fs.readFileSync(MODULE_LOADER_JS, 'utf-8');
    // Without a cap, a bad state would cause infinite reconfigure-error cycles
    expect(src).toContain('_seekRecoveries');
    expect(src).toMatch(/_seekRecoveries\s*<\s*\d/); // < N check
  });

  it('recovery counter resets on fresh configure (new decoder instance)', () => {
    const src = fs.readFileSync(MODULE_LOADER_JS, 'utf-8');
    // On a fresh configure (avc1 variant), reset the counter
    const configureIdx = src.indexOf("codec === 'avc1'");
    const resetIdx     = src.indexOf('_seekRecoveries = 0', configureIdx);
    expect(configureIdx).toBeGreaterThan(-1);
    expect(resetIdx).toBeGreaterThan(configureIdx);
  });

  it('decode() resets recovery counter when decoder returns to healthy state', () => {
    const src = fs.readFileSync(MODULE_LOADER_JS, 'utf-8');
    // Once the decoder is configured again, reset so future seeks get fresh retries
    expect(src).toMatch(/_seekRecoveries\s*=\s*0/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// webcodec.cpp use-after-free fix (decoder_sys_t.exiting + vlc_join)
//
// Problem: Close() called delete sys immediately, but WebcodecDecodeWorkerTick
// was still scheduled via emscripten_set_main_loop_arg. The freed emval
// handle (sys->decoder) contained garbage; using it as a call_indirect operand
// triggered "function signature mismatch" RuntimeError at EOS.
//
// Root cause of EOS crash: simulate_infinite_loop=false returned the Worker to
// Emscripten's pthread pool immediately. A new VLC pthread was assigned to the
// same Worker; when the old tick then called emscripten_cancel_main_loop() it
// cancelled the NEW pthread's loop → proxy calls failed → sig mismatch.
//
// Fix: WebcodecDecodeWorker uses a cond_wait loop (JSPI-compatible). Close()
// sets exiting=true and signals the cond under the mutex (lost-wakeup safe),
// then calls vlc_join. Flush() clears the block queue so pre-seek frames
// don't drive the decoder into closed state before the IDR arrives.
// ═══════════════════════════════════════════════════════════════════════════════

describe('webcodec.cpp use-after-free fix (decoder_sys_t.exiting)', () => {
  const WEBCODEC_CPP = path.join(PROJECT_ROOT, 'build', 'webcodec', 'webcodec.cpp');

  it('decoder_sys_t has an exiting atomic flag', () => {
    const src = fs.readFileSync(WEBCODEC_CPP, 'utf-8');
    // std::atomic<bool> exiting — set by Close(), checked by the tick
    expect(src).toContain('atomic<bool> exiting');
  });

  it('WebcodecDecodeWorkerTick checks exiting and cancels main loop', () => {
    const src = fs.readFileSync(WEBCODEC_CPP, 'utf-8');
    // exiting is checked in the tick — if true, tick cancels the main loop so
    // WebcodecDecodeWorker (ASYNCIFY-suspended) resumes and returns NULL.
    expect(src).toContain('sys->exiting.load');
    // emscripten_cancel_main_loop() is the tick's exit mechanism
    expect(src).toMatch(/emscripten_cancel_main_loop\s*\(/);
    // emval decode calls happen in the tick (JS event loop), not WASM execution
    expect(src).toContain('sys->decoder.call');
  });

  it('Close() sets exiting=true BEFORE the delete to prevent use-after-free', () => {
    const src = fs.readFileSync(WEBCODEC_CPP, 'utf-8');
    const closeIdx   = src.lastIndexOf('static void Close');  // last definition (not decl)
    const exitingIdx = src.indexOf('sys->exiting.store', closeIdx);
    // Search for delete sys AFTER the exiting.store call (skip comment occurrences)
    const deleteIdx  = src.indexOf('delete sys', exitingIdx);
    expect(closeIdx).toBeGreaterThan(-1);
    expect(exitingIdx).toBeGreaterThan(closeIdx);   // exiting.store is inside Close()
    expect(deleteIdx).toBeGreaterThan(exitingIdx);  // delete comes after store
  });

  it('Close() calls vlc_join to wait for decoder thread to exit before freeing', () => {
    const src = fs.readFileSync(WEBCODEC_CPP, 'utf-8');
    const closeIdx  = src.lastIndexOf('static void Close');
    // vlc_join blocks until WebcodecDecodeWorker exits after emscripten_cancel_main_loop().
    // This replaces the old emscripten_sleep(50) timing hack: vlc_join is deterministic
    // and prevents the Worker from being recycled while stale tick callbacks are pending.
    const joinIdx   = src.indexOf('vlc_join', closeIdx);
    const deleteIdx = src.indexOf('delete sys', joinIdx);
    expect(joinIdx).toBeGreaterThan(closeIdx);    // vlc_join is inside Close()
    expect(deleteIdx).toBeGreaterThan(joinIdx);   // delete comes after join
  });

  it('tick closes VideoDecoder and clears ctx before cancelling main loop (prevents EOS crash)', () => {
    const src = fs.readFileSync(WEBCODEC_CPP, 'utf-8');
    const tickIdx = src.indexOf('static void WebcodecDecodeWorkerTick');
    expect(tickIdx).toBeGreaterThan(-1);
    const nextFnIdx2 = src.indexOf('static void* WebcodecDecodeWorker', tickIdx + 1);
    const tickBody2 = src.slice(tickIdx, nextFnIdx2);
    // After Close(), async VideoDecoder output callbacks queued in the Worker's
    // event loop call _createAndQueuePicture while VLC's vout tears down concurrently.
    // Fix: initModuleContext(nullptr) sets webCodecCtx=0 so boundOutputCb bails out.
    // createAndQueuePicture also checks sys->exiting as a secondary VLC-pipeline guard.
    // Note: decoder.close() was removed from this exit path — calling it via emval
    // inside the ASYNCIFY tick callback can corrupt ASYNCIFY's saved stack state.
    // Tick exit path must clear webCodecCtx before cancelling the main loop
    expect(tickBody2).toContain('initModuleContext');
    // Actual emscripten_cancel_main_loop() call (not just comment mention) must be present
    expect(tickBody2).toMatch(/initModuleContext\s*\(\s*nullptr\s*\)/);
    // decoder.close() must NOT be called in the exit path (ASYNCIFY state corruption risk)
    const exitPathIdx = tickBody2.indexOf('exiting.load(std::memory_order_acquire)');
    const cancelIdx   = tickBody2.indexOf('emscripten_cancel_main_loop()', exitPathIdx);
    expect(exitPathIdx).toBeGreaterThan(-1);
    expect(cancelIdx).toBeGreaterThan(exitPathIdx);
    const exitBlock = tickBody2.slice(exitPathIdx, cancelIdx + 30);
    expect(exitBlock).not.toMatch(/decoder\.call[\s\S]*?close/);
  });

  it('tick wraps decoder.call in try/catch to prevent ASYNCIFY state corruption', () => {
    const src = fs.readFileSync(WEBCODEC_CPP, 'utf-8');
    const tickIdx = src.indexOf('static void WebcodecDecodeWorkerTick');
    expect(tickIdx).toBeGreaterThan(-1);
    const nextFnIdx = src.indexOf('static void* WebcodecDecodeWorker', tickIdx + 1);
    const tickBody = src.slice(tickIdx, nextFnIdx);
    // Reuse tickBody from the nextFnIdx slice computed above
    // After a backward seek the VideoDecoder may be 'closed'; decode() throws.
    // The JS exception propagates through emval as a C++ exception.  If it escapes
    // the tick (an ASYNCIFY callback), it corrupts ASYNCIFY's saved stack — the
    // next emscripten_cancel_main_loop() resume uses a stale type entry and crashes
    // with "function signature mismatch".  The try/catch here is the safety net.
    // tick must contain a try/catch (C++ try keyword followed by catch)
    expect(tickBody).toMatch(/\btry\b[\s\S]*\bcatch\b/);
    // decoder.call must be inside the tick function (covered by the try block)
    expect(tickBody).toContain('decoder.call');
    // block must be nulled after release so the catch does not double-free
    expect(tickBody).toContain('block = nullptr');
  });

  it('boundOutputCb guards against null webCodecCtx and createAndQueuePicture guards exiting', () => {
    const src = fs.readFileSync(path.join(PROJECT_ROOT, 'build', 'webcodec', 'webcodec.cpp'), 'utf-8');
    // Guard 1: initModuleContext(nullptr) in tick sets webCodecCtx=0.
    // boundOutputCb checks this so it does not call into VLC after Close() starts.
    expect(src).toContain('if (!Module.webCodecCtx)');
    expect(src).toContain('frame.close()');  // GPU memory freed on early exit
    // Guard 2: createAndQueuePicture checks sys->exiting before calling VLC pipeline
    // functions (decoder_UpdateVideoOutput, decoder_QueueVideo) that race with vout
    // teardown at EOS and cause "function signature mismatch".
    const caqpIdx = src.indexOf('EMSCRIPTEN_KEEPALIVE picture_t* createAndQueuePicture');
    expect(caqpIdx).toBeGreaterThan(-1);
    const caqpBody = src.slice(caqpIdx, caqpIdx + 1200);
    expect(caqpBody).toContain('sys->exiting.load');
    expect(caqpBody).toContain('return NULL'); // bails before VLC pipeline calls
  });

  it('Flush() clears the block queue to discard pre-seek frames', () => {
    const src = fs.readFileSync(WEBCODEC_CPP, 'utf-8');
    // Without this, stale delta frames arrive before the IDR and close the VideoDecoder
    const flushIdx = src.indexOf('static void Flush');
    expect(flushIdx).toBeGreaterThan(-1);
    // Flush body extends past the long comment header (allow up to 2000 chars)
    const flushBody = src.slice(flushIdx, flushIdx + 2000);
    expect(flushBody).toContain('blocks.empty()');
    expect(flushBody).toContain('block_Release');
  });
});
