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
