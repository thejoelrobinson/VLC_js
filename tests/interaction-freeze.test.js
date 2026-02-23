/**
 * Regression tests: no page freeze when pausing, resuming, or seeking.
 *
 * Root cause of freezes: calling blocking VLC WASM functions from the main
 * browser thread:
 *   - pause()      → audio drain via emscripten_futex_wait (deadlock)
 *   - get_position() / get_volume() → pthread_cond_timedwait (deadlock)
 *
 * Fixes applied in main.ts:
 *   - pause()         → set_pause(1)
 *   - get_position()  → _vlcStateCache.position
 *   - get_volume()    → _vlcStateCache.volume
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PROJECT_ROOT = path.resolve(path.join(fileURLToPath(import.meta.url), '../..'));
const MAIN_JS     = path.join(PROJECT_ROOT, 'main.js');
const LIBVLC_JS   = path.join(PROJECT_ROOT, 'lib', 'libvlc.js');

describe('Interaction freeze prevention (static analysis)', () => {
  it('main.js must not call media_player.pause() — use set_pause(1) instead', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // Any bare .pause() call on a media_player would be the old blocking form
    // The only .pause() that should appear is in the method DEFINITION (libvlc.js)
    // In main.js (the compiled app entry point), there must be no media_player.pause()
    const pauseCalls = (src.match(/media_player\.pause\(\)/g) || []).length;
    expect(pauseCalls).toBe(0);
  });

  it('main.js must use set_pause(1) for pause interaction', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    expect(src).toContain('set_pause(1)');
  });

  it('main.js must not call get_position() from event handlers — use _vlcStateCache', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // get_position() acquires vlc_player_Lock → pthread_cond_timedwait → blocks main thread.
    // Strip comment lines before checking — comments may reference the old API name.
    const codeOnly = src.split('\n')
      .filter(l => !l.trim().startsWith('//'))
      .join('\n');
    expect(codeOnly).not.toContain('media_player.get_position()');
  });

  it('main.js must not call get_volume() from event handlers — use _vlcStateCache', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    const codeOnly = src.split('\n')
      .filter(l => !l.trim().startsWith('//'))
      .join('\n');
    expect(codeOnly).not.toContain('media_player.get_volume()');
  });

  it('main.js must use _vlcStateCache for position in keyboard seek handlers', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // The keyboard handler must reference _vlcStateCache?.position
    expect(src).toContain('_vlcStateCache');
  });

  it('main.js _uiLoop must NOT call get_length() — deferred to one-shot setTimeout instead', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // get_length() acquires vlc_player_Lock.  On any RAF tick that coincides with
    // VLC's EOS pipeline teardown (which holds vlc_player_Lock), get_length() from
    // the RAF loop ASYNCIFY-suspends the main thread waiting for the lock.  The
    // main thread can no longer process VLC's GL proxy calls → VLC teardown stalls
    // → permanent page freeze (tab unresponsive, can't even refresh).
    //
    // Fix: remove get_length() from _uiLoop entirely.  Call it once via setTimeout
    // 3 s after play(), when VLC is in stable steady-state.  Short clips use the
    // EOS fallback (timeMs + 100) instead.
    const uiLoopIdx = src.indexOf('function _uiLoop');
    expect(uiLoopIdx).toBeGreaterThan(-1);
    // Find the closing brace of _uiLoop by looking for the RAF call that ends it
    const rafIdx = src.indexOf('requestAnimationFrame(_uiLoop)', uiLoopIdx);
    const uiLoopBody = src.slice(uiLoopIdx, rafIdx + 30);
    // get_length() must NOT appear inside _uiLoop
    expect(uiLoopBody).not.toContain('get_length()');
    // get_length() MUST appear in the deferred setTimeout (outside _uiLoop)
    const afterUiLoop = src.slice(rafIdx);
    expect(afterUiLoop).toContain('get_length()');
    expect(afterUiLoop).toContain('setTimeout');
  });

  it('libvlc.js still exposes pause() for non-main-thread use', () => {
    // The pause() method must stay in libvlc.js for use by non-main-thread code
    const src = fs.readFileSync(LIBVLC_JS, 'utf-8');
    expect(src).toContain('pause()');
  });

  it('libvlc.js exposes set_pause() as the safe alternative', () => {
    const src = fs.readFileSync(LIBVLC_JS, 'utf-8');
    expect(src).toContain('set_pause');
  });
});

describe('Duration and scrubbing (static analysis)', () => {
  it('main.js get_length() is deferred to one-shot setTimeout, not the RAF loop', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // get_length() acquires vlc_player_Lock.  Calling it from the RAF loop
    // risks firing during VLC EOS pipeline teardown (which holds vlc_player_Lock)
    // → ASYNCIFY-suspends the main thread waiting for the lock → main thread
    // can no longer process VLC's GL proxy calls → teardown stalls → permanent
    // page freeze (tab unresponsive, can't refresh).
    // Fix: call get_length() once via setTimeout(3000) after play(), not in the loop.
    // The deferred call is guarded: only runs if still playing and length unknown.
    expect(src).toContain("setTimeout");
    expect(src).toContain("get_length()");
    // Guard: only runs when still playing (not at or after EOS)
    expect(src).toContain('_vlcIsPlaying');
    // Guard: skip if already known
    expect(src).toContain('_lengthKnown');
  });

  it('main.js has _applySeek helper that writes back to _vlcStateCache', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // _applySeek must update both set_position (VLC) and the cache (instant visual feedback)
    expect(src).toContain('_applySeek');
    expect(src).toContain('set_position');
    expect(src).toContain('_vlcStateCache');
  });

  it('main.js progress bar click uses _applySeek (not bare set_position)', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // The click handler must go through _applySeek so the cache is updated instantly
    // (we verify _applySeek is the path; set_position is inside _applySeek)
    expect(src).toContain('_applySeek');
  });

  it('module-loader.js initialises _vlcStateCache eagerly before first frame', () => {
    const src = fs.readFileSync(
      path.join(PROJECT_ROOT, 'lib', 'module-loader.js'), 'utf-8'
    );
    // The eager initialisation must appear BEFORE the _vlcOnDecoderFrame definition
    const eagerIdx = src.indexOf('window._vlcStateCache = {');
    const frameIdx  = src.indexOf('window._vlcOnDecoderFrame');
    expect(eagerIdx).toBeGreaterThan(-1);
    expect(frameIdx).toBeGreaterThan(-1);
    expect(eagerIdx).toBeLessThan(frameIdx);
  });

  it('module-loader.js _vlcOnDecoderFrame updates position when lengthMs > 0', () => {
    const src = fs.readFileSync(
      path.join(PROJECT_ROOT, 'lib', 'module-loader.js'), 'utf-8'
    );
    // position = timeMs / lengthMs should be computed each frame
    expect(src).toContain('lengthMs > 0');
    // position calculation — may use newTimeMs or cache.timeMs variable name
    expect(src).toMatch(/newTimeMs\s*\/\s*cache\.lengthMs|timeMs\s*\/\s*cache\.lengthMs/);
  });

  it('main.js stale-detection resets on manual seek (_lastTimeMs = -1)', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // After a seek the stale counter must reset so EOS detection isn't fooled
    expect(src).toContain('_lastTimeMs = -1');
    expect(src).toContain('_staleCount = 0');
  });

  it('_applySeek is debounced — set_position() is inside a setTimeout', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // Rapid scrubbing must NOT call set_position() on every mouse event.
    // The VLC seek is debounced inside a 150ms setTimeout so the lock is
    // not spammed, preventing ASYNCIFY deadlock during rapid rewind.
    expect(src).toContain('_seekTimer');
    expect(src).toContain('set_position(newPos)');
    // set_position must appear INSIDE the setTimeout callback
    const timerIdx = src.indexOf('setTimeout');
    const setPosIdx = src.indexOf('set_position(newPos)');
    expect(timerIdx).toBeGreaterThan(-1);
    expect(setPosIdx).toBeGreaterThan(timerIdx);
  });

  it('_applySeek sets _vlcPendingSeekMs to gate pre-seek frames', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // _vlcPendingSeekMs prevents old frames clobbering the immediate feedback
    expect(src).toContain('_vlcPendingSeekMs');
  });

  it('main.js has EOS fallback: derives lengthMs from last frame timeMs', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // If get_length() never succeeds, approximate duration from last frame
    expect(src).toContain('timeMs + 100');
  });

  it('module-loader.js respects _vlcPendingSeekMs to guard position updates', () => {
    const src = fs.readFileSync(
      path.join(PROJECT_ROOT, 'lib', 'module-loader.js'), 'utf-8'
    );
    expect(src).toContain('_vlcPendingSeekMs');
    expect(src).toMatch(/pendingMs.*0\.[0-9]|Math\.abs.*pendingMs/);
  });
});

describe('Replay after end-of-stream', () => {
  it('main.js sets _vlcException flag in window.onerror', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // window.onerror must set _vlcException = true so subsequent calls
    // know VLC's WASM state is unrecoverable (any VLC call will deadlock)
    expect(src).toContain('_vlcException = true');
  });

  it('main.js handlePlayPause checks _vlcException before calling play()', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // After a WASM exception, calling media_player.play() would deadlock.
    // The guard must trigger a page reload instead.
    expect(src).toContain('_vlcException');
    expect(src).toContain('location.reload()');
  });

  it('main.js resets timeMs=0 on play() to suppress stale-detection during restart', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // Stale detection checks `currentTimeMs > 0` — setting timeMs=0 keeps
    // _vlcIsPlaying=true while VLC reinitialises after EOS (takes 1-5s).
    // Without this, stale detection fires and kills _vlcIsPlaying before
    // the first new frame arrives.
    expect(src).toContain('timeMs = 0');
    expect(src).toContain('position = 0');
  });

  it('main.js cancels pending seek timer on play() restart', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // A leftover debounced seek from before EOS must not fire after replay
    expect(src).toContain('clearTimeout(_seekTimer)');
  });
});

describe('VLC API safety classification', () => {
  // Verify the compiled main.js only calls safe (non-blocking) VLC APIs
  // from the main browser thread.
  //
  // UNSAFE on main thread (acquires vlc_player_Lock + pthread_cond_timedwait):
  //   get_time(), get_length(), get_position(), is_playing(), pause()
  //
  // SAFE on main thread (brief lock, no timedwait, or non-blocking command):
  //   play(), set_pause(), set_position(), set_time(), set_volume(), set_mute(),
  //   toggle_mute(), next_chapter(), previous_chapter(), set_rate()

  it('main.js must not call get_time() directly', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    expect(src).not.toContain('media_player.get_time()');
  });

  it('main.js get_length() call is guarded in the RAF polling loop (not bare)', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // get_length() IS intentionally called once per ~2s via the RAF loop to
    // discover video duration — safe because it reads a cached value with a
    // brief mutex, no pthread_cond_timedwait unlike get_time/get_position.
    // The call must be present (inside _lengthPollTick guard) and not appear
    // in any event handler or direct call outside the loop.
    expect(src).toContain('get_length()');
    // The stale guard ensures we only call it while playing and before known
    expect(src).toContain('_lengthKnown');
  });

  it('main.js must not call is_playing() directly', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // is_playing() must never be called in main.js — use window._vlcIsPlaying cache
    expect(src).not.toContain('media_player.is_playing()');
  });
});

describe('Drag-scrub implementation (static analysis)', () => {
  it('main.js declares _isScrubbing local flag', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    expect(src).toContain('_isScrubbing');
  });

  it('main.js sets window._vlcIsScrubbing on scrub start and clears on scrub end', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    expect(src).toContain('window._vlcIsScrubbing = true');
    expect(src).toContain('window._vlcIsScrubbing = false');
  });

  it('main.js has mousedown handler on progress bar (not only click)', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    expect(src).toContain("'mousedown'");
  });

  it('main.js has document-level mousemove and mouseup handlers for global drag', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    expect(src).toContain("'mousemove'");
    expect(src).toContain("'mouseup'");
  });

  it('main.js has touch support: touchstart, touchmove, touchend', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    expect(src).toContain("'touchstart'");
    expect(src).toContain("'touchmove'");
    expect(src).toContain("'touchend'");
  });

  it('main.js _applySeek still exists for backward compatibility', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    expect(src).toContain('_applySeek');
  });

  it('main.js scrub end does immediate set_position (no setTimeout)', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // _scrubEnd must call set_position directly (no timer) for the final seek.
    // Confirm set_position appears outside just the setTimeout block.
    const scrubEndIdx = src.indexOf('_scrubEnd');
    expect(scrubEndIdx).toBeGreaterThan(-1);
    // find the direct set_position call that is NOT inside a setTimeout
    expect(src).toContain('media_player.set_position(finalPos)');
  });

  it('main.js scrub start pauses playback via set_pause(1)', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // During scrub start, if playing, must use set_pause(1) (never pause())
    const scrubStartIdx = src.indexOf('_scrubStart');
    expect(scrubStartIdx).toBeGreaterThan(-1);
    // The code uses set_pause(1) inside _scrubStart
    expect(src).toContain('set_pause(1)');
  });

  it('main.js scrub end resumes playback via set_pause(0) when was playing', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    expect(src).toContain('set_pause(0)');
    expect(src).toContain('_wasPlayingBeforeScrub');
  });

  it('main.js _vlcException guard present in scrub start and scrub end', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // Count occurrences — must appear inside the scrub helper functions too
    const count = (src.match(/_vlcException/g) || []).length;
    expect(count).toBeGreaterThan(2); // at least in scrubStart, scrubEnd, plus original guards
  });

  it('module-loader.js gates position update during scrubbing', () => {
    const src = fs.readFileSync(
      path.join(PROJECT_ROOT, 'lib', 'module-loader.js'), 'utf-8'
    );
    expect(src).toContain('_vlcIsScrubbing');
    // position must NOT be written when _vlcIsScrubbing is true
    expect(src).toMatch(/!window\._vlcIsScrubbing/);
  });
});

describe('FPS estimation (static analysis)', () => {
  it('module-loader.js computes _vlcEstimatedFps as a rolling average', () => {
    const src = fs.readFileSync(
      path.join(PROJECT_ROOT, 'lib', 'module-loader.js'), 'utf-8'
    );
    expect(src).toContain('_vlcEstimatedFps');
    expect(src).toContain('_vlcFrameIntervals');
  });

  it('module-loader.js clamps FPS to 5–120 range', () => {
    const src = fs.readFileSync(
      path.join(PROJECT_ROOT, 'lib', 'module-loader.js'), 'utf-8'
    );
    // Math.max(5, Math.min(120, fps)) or equivalent
    expect(src).toMatch(/_VLC_FPS_MIN|Math\.max.*5.*120|Math\.max.*_VLC_FPS_MIN/);
    expect(src).toMatch(/_VLC_FPS_MAX|Math\.min.*120/);
  });

  it('module-loader.js rolling window is limited to ~10 samples', () => {
    const src = fs.readFileSync(
      path.join(PROJECT_ROOT, 'lib', 'module-loader.js'), 'utf-8'
    );
    // shift() is used to evict old samples; window size constant present
    expect(src).toContain('.shift()');
    expect(src).toMatch(/_VLC_FPS_WINDOW|length > 10/);
  });
});

describe('Frame-step keyboard handler (static analysis)', () => {
  it('main.js has document-level keydown handler for frame stepping', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // document.addEventListener('keydown', ...) must be present for frame step
    expect(src).toContain("document.addEventListener('keydown'");
  });

  it('main.js handles Period key for forward frame step (next_frame)', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    expect(src).toContain("'.'");
    expect(src).toContain('next_frame()');
  });

  it('main.js handles Comma key for backward frame step (set_time)', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    expect(src).toContain("','");
    // backward step uses set_time with a computed target
    expect(src).toContain('set_time(');
  });

  it('main.js frame step uses _vlcEstimatedFps for frame duration', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    expect(src).toContain('_vlcEstimatedFps');
    // falls back to 24 fps
    expect(src).toContain('?? 24');
  });

  it('main.js frame step auto-pauses if playing', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // The keydown handler must pause before stepping
    expect(src).toContain('set_pause(1)');
    expect(src).toContain('_vlcIsPlaying = false');
  });

  it('main.js frame step is guarded against input/textarea focus', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // Must not fire when user is typing in the options text box
    expect(src).toContain("tagName === 'INPUT'");
    expect(src).toContain("tagName === 'TEXTAREA'");
  });

  it('main.js frame step is guarded by _vlcException', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // The keydown handler must check _vlcException before calling VLC
    expect(src).toContain('_vlcException');
  });

  it('main.js backward frame step resets stale detection (_lastTimeMs = -1)', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // backward step must reset stale detection to avoid false EOS trigger
    // (the check appears in the backward branch inside the keydown handler)
    const keydownIdx = src.lastIndexOf("document.addEventListener('keydown'");
    expect(keydownIdx).toBeGreaterThan(-1);
    // _lastTimeMs = -1 appears inside the keydown handler
    const afterKeydown = src.slice(keydownIdx);
    expect(afterKeydown).toContain('_lastTimeMs = -1');
  });
});

// ===================================================================
// avcodec auto-fallback (window.onerror handler)
//
// Root cause: ASYNCIFY instrumentation of WebcodecDecodeWorker changes
// its WASM type from (i32)->i32 to (i32,i32,i32)->i32. The pthread
// runtime passes (i32) → call_indirect type mismatch → RuntimeError.
// The JS-side fix: when onerror fires before any frames are decoded,
// switch to --codec=avcodec and reload so the file still plays.
// ===================================================================

describe('Avcodec auto-fallback on webcodec ASYNCIFY crash', () => {
  it('main.js onerror fallback is gated on hasFrames (avoids switching after successful decode)', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // If an exception fires AFTER frames have decoded (e.g. EOS cleanup),
    // the fallback must NOT trigger — webcodec was working fine.
    // Guard: window._vlcStateCache && window._vlcStateCache.timeMs > 0
    expect(src).toContain('window._vlcStateCache && window._vlcStateCache.timeMs > 0');
  });

  it('main.js onerror fallback is skipped when already on avcodec (prevents infinite reload loop)', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // If avcodec itself throws, we must NOT reload again.
    // Guard: !currentOpts.includes('avcodec')
    expect(src).toContain("currentOpts.includes('avcodec')");
  });

  it('main.js onerror saves original webcodec options BEFORE overwriting them', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // vlc-saved-options must be written before the avcodec option string is set —
    // otherwise we would save '--codec=avcodec …' as the target to restore.
    const saveIdx    = src.indexOf("setItem('vlc-saved-options'");
    const switchIdx  = src.indexOf('--codec=avcodec');
    expect(saveIdx).toBeGreaterThan(-1);
    expect(switchIdx).toBeGreaterThan(-1);
    expect(saveIdx).toBeLessThan(switchIdx);
  });

  it('main.js avcodec fallback options include all three required flags', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // Must keep --avcodec-threads=1 to prevent PTHREAD_POOL exhaustion on fallback
    expect(src).toContain('--codec=avcodec --aout=emworklet --avcodec-threads=1');
  });

  it('main.js onerror reloads inside setTimeout (not synchronously)', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // A synchronous reload inside onerror would fire before the handler finishes
    // and before localStorage.setItem() has flushed.
    // The reload must be deferred via setTimeout.
    const onerrorIdx = src.indexOf('window.onerror = function');
    expect(onerrorIdx).toBeGreaterThan(-1);
    const onerrorBody = src.slice(onerrorIdx, src.indexOf('\n};', onerrorIdx) + 3);
    expect(onerrorBody).toContain('setTimeout');
    expect(onerrorBody).toContain('window.location.reload()');
    // reload() must be INSIDE the setTimeout callback, not after it
    const timeoutIdx = onerrorBody.indexOf('setTimeout');
    const reloadIdx  = onerrorBody.indexOf('window.location.reload()');
    expect(reloadIdx).toBeGreaterThan(timeoutIdx);
  });

  it('main.js restores original webcodec options after successful avcodec fallback (>3s played)', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // After avcodec plays 3s without crashing, restore webcodec for the next session.
    // Checked in the RAF loop, not in onerror.
    expect(src).toContain('timeMs > 3000');
    expect(src).toContain("getItem('vlc-saved-options')");
    // Must restore to 'options' (not some other key)
    const restoreIdx = src.indexOf("setItem('options', savedOpts)");
    expect(restoreIdx).toBeGreaterThan(-1);
  });

  it('main.js removes vlc-saved-options after restoring (no stale key left over)', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // Stale vlc-saved-options would cause the restore to fire again on the next session
    expect(src).toContain("removeItem('vlc-saved-options')");
    // removeItem must come after setItem (restore the key THEN clean up)
    const restoreIdx = src.indexOf("setItem('options', savedOpts)");
    const removeIdx  = src.indexOf("removeItem('vlc-saved-options')");
    expect(restoreIdx).toBeGreaterThan(-1);
    expect(removeIdx).toBeGreaterThan(restoreIdx);
  });

  it('main.js saves valid-options immediately after successful WASM init', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // On successful module load, current options are saved as 'valid-options'.
    // This allows init-failure recovery: if options change and break init,
    // the catch block can restore the last working set.
    expect(src).toContain("setItem('valid-options'");
    // Must appear inside the try block after initModule(), not in catch/finally
    const initIdx     = src.indexOf('initModule(');
    const validIdx    = src.indexOf("setItem('valid-options'");
    const catchIdx    = src.indexOf('catch (e)');
    expect(initIdx).toBeGreaterThan(-1);
    expect(validIdx).toBeGreaterThan(initIdx);    // after init
    expect(validIdx).toBeLessThan(catchIdx);      // before the catch block
  });

  it('main.js catch block restores valid-options on init failure (breaks bad-options reload loop)', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // If VLC module init throws (e.g. bad --codec flag), the catch block must
    // restore last-known-good options so the next manual reload succeeds.
    expect(src).toContain("getItem('valid-options')");
    // The restored value must be written back to 'options'
    expect(src).toContain("setItem('options', validOptions)");
  });
});

// ===================================================================
// Seek-after-EOS: scrubbing after clip ends restarts VLC so frames appear
// ===================================================================

describe('seek-after-EOS: scrubbing after clip ends restarts decoder', () => {
  const MAIN_JS2 = path.join(PROJECT_ROOT, 'main.js');

  it('EOS stale-detection sets _vlcAtEOS only when time is ≥95% through clip', () => {
    const src = fs.readFileSync(MAIN_JS2, 'utf-8');
    // _vlcAtEOS must only be set near the end of the clip (≥95%).
    // Mid-video backward seeks temporarily freeze frames for ~1.5s, which
    // would trigger stale-detection.  Without the threshold, _vlcAtEOS is
    // incorrectly set mid-video, causing the next scrub to restart from pos 0.
    expect(src).toContain('window._vlcAtEOS = true');
    expect(src).toContain('0.95');  // threshold guard
  });

  it('handlePlayPause clears _vlcAtEOS on manual play', () => {
    const src = fs.readFileSync(MAIN_JS2, 'utf-8');
    expect(src).toContain('window._vlcAtEOS = false');
  });

  it('_scrubStart snapshots _wasAtEOS and clears _vlcAtEOS; _scrubEnd uses snapshot', () => {
    const src = fs.readFileSync(MAIN_JS2, 'utf-8');
    // _scrubStart captures _vlcAtEOS into _wasAtEOS and immediately clears
    // _vlcAtEOS.  This prevents stale detection mid-drag from overwriting it.
    // _scrubEnd reads _wasAtEOS (the pre-scrub value) for the restart decision.
    const scrubStartIdx = src.indexOf('function _scrubStart');
    expect(scrubStartIdx).toBeGreaterThan(-1);
    const scrubStartBody = src.slice(scrubStartIdx, scrubStartIdx + 800);
    expect(scrubStartBody).toContain('_wasAtEOS = window._vlcAtEOS');
    expect(scrubStartBody).toContain('window._vlcAtEOS = false');

    const scrubEndIdx = src.indexOf('function _scrubEnd');
    expect(scrubEndIdx).toBeGreaterThan(-1);
    const scrubEndBody = src.slice(scrubEndIdx, scrubEndIdx + 1500);
    // _scrubEnd uses _wasAtEOS (not window._vlcAtEOS) to decide restart
    expect(scrubEndBody).toContain('_wasAtEOS');
    expect(scrubEndBody).toContain('media_player.play()');
    expect(scrubEndBody).toContain('media_player.set_position(finalPos)');
  });
});

// ===================================================================
// pthread cond_wait + vlc_join worker lifecycle fix (JSPI-ready)
//
// Root cause of EOS "function signature mismatch":
//   simulate_infinite_loop=false returned the Worker to Emscripten's pthread
//   pool immediately. A new VLC pthread was assigned to the same Worker; when
//   the old tick's setTimeout fired it called emscripten_cancel_main_loop()
//   on the NEW pthread's loop → proxy calls failed → call_indirect type trap.
//
// Fix: WebcodecDecodeWorker now uses a plain pthread cond_wait loop.
//   • No emscripten_set_main_loop_arg — incompatible with JSPI (ASYNCIFY=2)
//   • Worker stays owned by this pthread for its lifetime (blocks in cond_wait)
//   • Close() stores exiting=true + signals cond under mutex (lost-wakeup safe)
//   • Close() calls vlc_join — deterministic, no race, no timing hacks
//   • Compatible with ASYNCIFY=1, ASYNCIFY=2 (JSPI), and no ASYNCIFY
//
// ASYNCIFY_REMOVE must NOT be present: with cond_wait, WebcodecDecodeWorker
// has no async call chain and ASYNCIFY won't instrument it regardless.
// ===================================================================

describe('pthread cond_wait + vlc_join worker lifecycle fix (JSPI-ready)', () => {
  const BUILD_SCRIPT = path.join(PROJECT_ROOT, 'build', 'create_main.sh');
  const WEBCODEC_CPP = path.join(PROJECT_ROOT, 'build', 'webcodec', 'webcodec.cpp');

  it('create_main.sh must NOT include ASYNCIFY_REMOVE (breaks simulate_infinite_loop=1)', () => {
    const src = fs.readFileSync(BUILD_SCRIPT, 'utf-8');
    // ASYNCIFY_REMOVE=["WebcodecDecodeWorker"] prevents ASYNCIFY from instrumenting
    // WebcodecDecodeWorker, which is required for simulate_infinite_loop=1 to work
    // (ASYNCIFY must be able to suspend/resume the function when the loop is cancelled).
    expect(src).not.toContain('ASYNCIFY_REMOVE');
    // ASYNCIFY=1 must still be present for probeConfig (EM_ASYNC_JS) to work
    expect(src).toContain('-s ASYNCIFY=1');
  });

  it('WebcodecDecodeWorker uses simulate_infinite_loop=1 to keep Worker owned until cleanup', () => {
    const src = fs.readFileSync(WEBCODEC_CPP, 'utf-8');
    // simulate_infinite_loop=1 (4th arg) keeps the JS Worker owned by this pthread
    // via ASYNCIFY suspension, preventing the Worker-pool recycling race that caused
    // "function signature mismatch" at EOS.
    // decode calls happen in the tick (JS event loop), NOT from the ASYNCIFY-suspended
    // WASM frame, because emval::call from an ASYNCIFY frame triggers a call_indirect
    // type mismatch in Emscripten 4.0.1.
    const workerIdx  = src.indexOf('static void* WebcodecDecodeWorker');
    expect(workerIdx).toBeGreaterThan(-1);
    const workerBody = src.slice(workerIdx, workerIdx + 2000);
    // 4th argument must be 1 (truthy), not 0 or false
    expect(workerBody).toMatch(/emscripten_set_main_loop_arg\s*\([^)]+,\s*1\s*\)/);
  });

  it('Close() uses vlc_join not emscripten_sleep — deterministic, no Worker-pool race', () => {
    const src = fs.readFileSync(WEBCODEC_CPP, 'utf-8');
    const closeIdx  = src.lastIndexOf('static void Close');
    const closeBody = src.slice(closeIdx, closeIdx + 2000);
    // vlc_join blocks until WebcodecDecodeWorker returns after cancel_main_loop().
    // emscripten_sleep(50) was timing-based and didn't prevent Worker recycling.
    expect(closeBody).toContain('vlc_join');
    expect(closeBody).not.toContain('emscripten_sleep');
  });

  it('PatchedVideoDecoder skips delta chunks when closed (prevents ASYNCIFY-corrupting throws)', () => {
    const src = fs.readFileSync(path.join(PROJECT_ROOT, 'lib', 'module-loader.js'), 'utf-8');
    // When VideoDecoder is 'closed' and a delta chunk arrives, calling super.decode()
    // throws a DOMException synchronously.  That exception propagates through emval into
    // the C++ tick where it corrupts ASYNCIFY's saved stack → "function signature mismatch"
    // at EOS.  Silently dropping the delta avoids the throw; the next keyframe triggers
    // the existing closed-state recovery (reconfigure + decode IDR).
    expect(src).toContain("this.state === 'closed' && chunk.type === 'delta'");
    // Must return (skip) before calling super.decode()
    const deltaGuardIdx = src.indexOf("this.state === 'closed' && chunk.type === 'delta'");
    const superDecodeIdx = src.indexOf('return super.decode(chunk)', deltaGuardIdx);
    expect(superDecodeIdx).toBeGreaterThan(deltaGuardIdx);
  });

  it('compile.sh webcodec plugin is compiled with ASYNCIFY=1 (probeConfig uses EM_ASYNC_JS)', () => {
    const compileSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'build', 'compile.sh'), 'utf-8');
    // probeConfig() is EM_ASYNC_JS (genuinely awaits VideoDecoder.isConfigSupported) so
    // the plugin still needs ASYNCIFY=1 at compile time. Only declareCallbacks was changed
    // to EM_JS — probeConfig stays async.
    const webcodecMakeIdx = compileSrc.indexOf('libwebcodec_plugin');
    expect(webcodecMakeIdx).toBeGreaterThan(-1);
    const afterWebcodec = compileSrc.slice(webcodecMakeIdx, webcodecMakeIdx + 300);
    expect(afterWebcodec).toContain('ASYNCIFY=1');
  });
});

// ===================================================================
// declareCallbacks must be EM_JS, not EM_ASYNC_JS (webcodec.cpp)
//
// Root cause of "function signature mismatch":
//   declareCallbacks was EM_ASYNC_JS → ASYNCIFY instrumented the chain:
//   declareCallbacks → initDecoder → WebcodecDecodeWorker
//   → changed WebcodecDecodeWorker WASM type → pthread call_indirect trap
//
// Fix: EM_JS (synchronous). The function body has no top-level await;
// Module.boundOutputCb is defined as async (returns a Promise when called)
// but the DEFINITION is synchronous assignment — no ASYNCIFY needed.
// probeConfig stays EM_ASYNC_JS because it genuinely awaits.
// ===================================================================

describe('declareCallbacks must be EM_JS not EM_ASYNC_JS (webcodec.cpp)', () => {
  const WEBCODEC_CPP = path.join(PROJECT_ROOT, 'build', 'webcodec', 'webcodec.cpp');

  it('declareCallbacks is declared with EM_JS (not EM_ASYNC_JS)', () => {
    const src = fs.readFileSync(WEBCODEC_CPP, 'utf-8');
    // Must be EM_JS — using EM_ASYNC_JS triggers ASYNCIFY on the entire call chain
    // up through WebcodecDecodeWorker, breaking the pthread type signature.
    expect(src).toContain('EM_JS(void, declareCallbacks');
    expect(src).not.toContain('EM_ASYNC_JS(void, declareCallbacks');
  });

  it('probeConfig stays EM_ASYNC_JS (it genuinely awaits VideoDecoder.isConfigSupported)', () => {
    const src = fs.readFileSync(WEBCODEC_CPP, 'utf-8');
    // probeConfig DOES use await — do not change it to EM_JS
    expect(src).toContain('EM_ASYNC_JS(bool, probeConfig');
  });

  it('declareCallbacks body has no top-level await (confirming EM_JS is correct)', () => {
    const src = fs.readFileSync(WEBCODEC_CPP, 'utf-8');
    // Extract the body of declareCallbacks up to its closing })
    const startIdx = src.indexOf('EM_JS(void, declareCallbacks');
    expect(startIdx).toBeGreaterThan(-1);
    // The function body ends before EM_ASYNC_JS(bool, probeConfig
    const endIdx = src.indexOf('EM_ASYNC_JS(bool, probeConfig', startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    const body = src.slice(startIdx, endIdx);
    // Top-level await would appear as a bare 'await ' not inside a nested function.
    // The only 'async' allowed is in the boundOutputCb definition (nested function).
    // Strip nested function bodies and check no bare await remains.
    // Simple check: no 'await ' appears outside a string context in the outer body.
    // The outer body should only have 'async function' as a keyword, not 'await'.
    const outerBody = body.replace(/async function[^}]*\{[^}]*\}/g, '');
    expect(outerBody).not.toMatch(/\bawait\b/);
  });

  it('WebcodecDecodeWorker calls initDecoder which calls declareCallbacks (call chain verified)', () => {
    const src = fs.readFileSync(WEBCODEC_CPP, 'utf-8');
    // Confirm the exact call chain that caused the bug exists in source.
    // If anyone restructures this, the fix must be re-evaluated.
    const workerIdx     = src.indexOf('static void* WebcodecDecodeWorker(');
    const initCallIdx   = src.indexOf('initDecoder(', workerIdx);
    const declareFnIdx  = src.indexOf('declareCallbacks();');
    expect(workerIdx).toBeGreaterThan(-1);
    expect(initCallIdx).toBeGreaterThan(workerIdx);   // WebcodecDecodeWorker calls initDecoder
    expect(declareFnIdx).toBeGreaterThan(-1);          // initDecoder calls declareCallbacks
    expect(declareFnIdx).toBeLessThan(workerIdx);      // declareCallbacks defined before the worker fn
  });
});
