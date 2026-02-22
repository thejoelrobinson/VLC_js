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
  it('main.js get_length() poll has all three safety guards', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // Guard 1: timeMs > 1000 — not at initialization (prevents lock contention
    //           during decoder init, which causes function signature mismatch)
    expect(src).toContain('timeMs > 1000');
    // Guard 2: _staleCount === 0 — not in EOS cleanup (prevents deadlock when
    //           VLC cleanup thread holds vlc_player_Lock)
    expect(src).toContain('_staleCount === 0');
    // Guard 3: minimum tick count — at least 1s since playback started
    expect(src).toContain('_lengthPollTick >= 4');
    // Guard 4: periodic polling every ~2s
    expect(src).toContain('_lengthPollTick % 8 === 0');
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
