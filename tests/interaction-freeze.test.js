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

  it('main.js must not call get_length() directly', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    expect(src).not.toContain('media_player.get_length()');
  });

  it('main.js must not call is_playing() directly', () => {
    const src = fs.readFileSync(MAIN_JS, 'utf-8');
    // is_playing() must never be called in main.js — use window._vlcIsPlaying cache
    expect(src).not.toContain('media_player.is_playing()');
  });
});
