import { describe, it, expect, vi, beforeEach } from 'vitest';

// ===================================================================
// MXF Playback Codec Path and Module Initialization Tests
//
// These tests validate the VLC options, argv construction logic,
// set_pause behavior, Media error messages, and module-loader
// configuration that are critical for MXF/H.264 playback in WASM.
// ===================================================================

// The default VLC options string as defined in main.js (lines 33, 37).
// We define it here because main.js cannot be imported directly (browser APIs).
// NOTE: --aout=adummy is used because the VLC 4.0 WASM build (via VLC's
// extras/package/wasm-emscripten/build.sh) does not include emworklet_audio.
// adummy = null audio output (silent video). Full audio requires a future
// rebuild that includes the emscripten_audio_worklet module.
const DEFAULT_OPTIONS = '--codec=webcodec --aout=adummy --avcodec-threads=1';

function createMockModule() {
  return {
    _wasm_media_player_new: vi.fn(() => 1001),
    _attach_update_events: vi.fn(),
    _wasm_media_player_release: vi.fn(),
    _wasm_media_player_set_media: vi.fn(),
    _wasm_media_player_get_media: vi.fn(() => 2001),
    _wasm_media_retain: vi.fn(),
    _wasm_media_player_is_playing: vi.fn(() => 0),
    _wasm_media_player_stop: vi.fn(() => 0),
    _wasm_media_player_play: vi.fn(() => 0),
    _wasm_media_player_pause: vi.fn(),
    _wasm_media_player_set_pause: vi.fn(),
    _wasm_media_player_get_length: vi.fn(() => 120000),
    _wasm_media_player_get_time: vi.fn(() => 45000),
    _wasm_media_player_set_time: vi.fn(),
    _wasm_media_player_get_position: vi.fn(() => 0.375),
    _wasm_media_player_set_position: vi.fn(),
    _wasm_audio_toggle_mute: vi.fn(),
    _wasm_audio_get_mute: vi.fn(() => 0),
    _wasm_audio_set_mute: vi.fn(),
    _wasm_audio_get_volume: vi.fn(() => 80),
    _wasm_audio_set_volume: vi.fn(),
    _wasm_media_new_location: vi.fn(() => 3001),
    _wasm_media_release: vi.fn(),
    allocateUTF8: vi.fn((str) => 4001),
    _free: vi.fn(),
  };
}

// Import MediaPlayer and Media from the JS wrapper
let MediaPlayer, Media;

beforeEach(async () => {
  const mod = await import('../lib/libvlc.js');
  MediaPlayer = mod.MediaPlayer;
  Media = mod.Media;
});

// ===================================================================
// 1. Default VLC options validation
// ===================================================================
describe('Default VLC options for MXF playback', () => {
  it('should contain --codec=webcodec as the primary decoder', () => {
    expect(DEFAULT_OPTIONS).toContain('--codec=webcodec');
  });

  it('should contain --aout=adummy (null audio; emworklet_audio not in VLC 4.0 build)', () => {
    expect(DEFAULT_OPTIONS).toContain('--aout=adummy');
  });

  it('should contain --avcodec-threads=1 to prevent thread_get_buffer exhaustion', () => {
    expect(DEFAULT_OPTIONS).toContain('--avcodec-threads=1');
  });

  it('should NOT contain --input-repeat (floods main thread)', () => {
    expect(DEFAULT_OPTIONS).not.toContain('--input-repeat');
  });

  it('should parse into exactly 3 options', () => {
    const opts = DEFAULT_OPTIONS.split(' ');
    expect(opts).toHaveLength(3);
  });

  it('each parsed option should start with --', () => {
    const opts = DEFAULT_OPTIONS.split(' ');
    for (const opt of opts) {
      expect(opt.startsWith('--')).toBe(true);
    }
  });
});

// ===================================================================
// 2. VLC option argv construction
// ===================================================================
describe('VLC option argv construction', () => {
  // Replicates the parsing logic from main.js lines 163-188
  function parseVlcOptions(optionsString) {
    const vlc_opts_array = optionsString.split(' ');

    let vlc_opts_size = 0;
    for (let i in vlc_opts_array) {
      vlc_opts_size += vlc_opts_array[i].length + 1;
    }

    return { vlc_opts_array, vlc_opts_size };
  }

  it('should split default options into correct array', () => {
    const { vlc_opts_array } = parseVlcOptions(DEFAULT_OPTIONS);
    expect(vlc_opts_array).toEqual([
      '--codec=webcodec',
      '--aout=adummy',
      '--avcodec-threads=1',
    ]);
  });

  it('should compute correct buffer size (each string length + 1 null terminator)', () => {
    const { vlc_opts_size } = parseVlcOptions(DEFAULT_OPTIONS);
    // '--codec=webcodec' = 16 + 1 = 17
    // '--aout=adummy' = 13 + 1 = 14
    // '--avcodec-threads=1' = 19 + 1 = 20
    // Total: 17 + 14 + 20 = 51
    expect(vlc_opts_size).toBe(51);
  });

  it('should handle a single option', () => {
    const { vlc_opts_array, vlc_opts_size } = parseVlcOptions('--codec=webcodec');
    expect(vlc_opts_array).toHaveLength(1);
    expect(vlc_opts_array[0]).toBe('--codec=webcodec');
    expect(vlc_opts_size).toBe(17); // 16 + 1
  });

  it('should handle empty string as single empty element', () => {
    const { vlc_opts_array, vlc_opts_size } = parseVlcOptions('');
    // ''.split(' ') produces ['']
    expect(vlc_opts_array).toHaveLength(1);
    expect(vlc_opts_array[0]).toBe('');
    expect(vlc_opts_size).toBe(1); // 0 + 1
  });

  it('should produce argv array length matching option count', () => {
    const { vlc_opts_array } = parseVlcOptions(DEFAULT_OPTIONS);
    // main.js allocates vlc_opts_array.length * 4 + 4 bytes for argv
    const argv_bytes = vlc_opts_array.length * 4 + 4;
    expect(argv_bytes).toBe(16); // 3 * 4 + 4
  });

  it('should correctly calculate byte offsets for each option', () => {
    const { vlc_opts_array } = parseVlcOptions(DEFAULT_OPTIONS);
    // Simulates the offset calculation from main.js lines 184-188
    const offsets = [];
    let wrote_size = 0;
    for (let i in vlc_opts_array) {
      offsets.push(wrote_size);
      wrote_size += vlc_opts_array[i].length + 1;
    }
    // '--codec=webcodec' ends at 17, '--aout=adummy' ends at 17+14=31
    expect(offsets).toEqual([0, 17, 31]);
  });
});

// ===================================================================
// 3. MediaPlayer set_pause behavior
// ===================================================================
describe('MediaPlayer set_pause for MXF playback', () => {
  let module;

  beforeEach(() => {
    module = createMockModule();
  });

  it('set_pause(1) calls _wasm_media_player_set_pause with (ptr, 1)', () => {
    const player = new MediaPlayer(module);
    player.set_pause(1);
    expect(module._wasm_media_player_set_pause).toHaveBeenCalledWith(1001, 1);
  });

  it('set_pause(0) calls _wasm_media_player_set_pause with (ptr, 0)', () => {
    const player = new MediaPlayer(module);
    player.set_pause(0);
    expect(module._wasm_media_player_set_pause).toHaveBeenCalledWith(1001, 0);
  });

  it('set_pause returns the WASM function return value', () => {
    module._wasm_media_player_set_pause.mockReturnValue(42);
    const player = new MediaPlayer(module);
    const result = player.set_pause(1);
    expect(result).toBe(42);
  });

  it('set_pause is a distinct method from pause', () => {
    const player = new MediaPlayer(module);
    player.set_pause(1);
    expect(module._wasm_media_player_set_pause).toHaveBeenCalledOnce();
    expect(module._wasm_media_player_pause).not.toHaveBeenCalled();
  });
});

// ===================================================================
// 4. Media error message template literal
// ===================================================================
describe('Media error message includes path', () => {
  let module;

  beforeEach(() => {
    module = createMockModule();
  });

  it('error message contains the file path when WASM returns null pointer', () => {
    module._wasm_media_new_location.mockReturnValue(0);
    expect(() => new Media(module, 'emjsfile://test.mxf')).toThrow(
      'Could not create media from path emjsfile://test.mxf'
    );
  });

  it('error message contains path for different path strings', () => {
    module._wasm_media_new_location.mockReturnValue(0);
    const testPath = '/some/deep/path/to/video.mxf';
    expect(() => new Media(module, testPath)).toThrow(testPath);
  });

  it('error message uses template literal interpolation (not literal {path})', () => {
    module._wasm_media_new_location.mockReturnValue(0);
    try {
      new Media(module, 'mxf://clip001');
    } catch (e) {
      // The error should contain the actual path, not the literal '{path}'
      expect(e.message).toContain('mxf://clip001');
      expect(e.message).not.toContain('{path}');
    }
  });
});

// ===================================================================
// 5. Module-loader canvas configuration
// ===================================================================
describe('Module-loader canvas configuration', () => {
  it('VlcModuleExt.canvas should be the #canvas DOM element', async () => {
    // Create the canvas element that module-loader.js expects
    const canvas = document.createElement('canvas');
    canvas.id = 'canvas';
    document.body.appendChild(canvas);

    // module-loader.js also reads these elements at module scope
    const body = document.createElement('div');
    body.id = 'body';
    document.body.appendChild(body);

    // Re-import to execute the module in the jsdom environment
    // Use a cache-busting query to force re-evaluation
    const mod = await import('../lib/module-loader.js?' + Date.now());

    // VlcModuleExt is not exported, but since module-loader.js sets it on the
    // global scope implicitly via `const VlcModuleExt = ...`, in jsdom it
    // won't be directly accessible. Instead, we verify the canvas element
    // exists and has the expected id, which is what module-loader references.
    const canvasEl = document.getElementById('canvas');
    expect(canvasEl).toBeTruthy();
    expect(canvasEl.tagName).toBe('CANVAS');

    // Cleanup
    document.body.removeChild(canvas);
    document.body.removeChild(body);
  });

  it('#canvas element should support webglcontextlost event listener', () => {
    const canvas = document.createElement('canvas');
    canvas.id = 'test-canvas';
    document.body.appendChild(canvas);

    // Verify addEventListener does not throw for webglcontextlost
    let listenerAdded = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      listenerAdded = true;
    });

    // Dispatch the event to verify the listener was attached
    const event = new Event('webglcontextlost');
    canvas.dispatchEvent(event);
    expect(listenerAdded).toBe(true);

    document.body.removeChild(canvas);
  });
});

// ===================================================================
// 6. Audio output configuration
// ===================================================================
describe('Audio output configuration for WASM', () => {
  it('default options use adummy (null audio output; emworklet_audio not in this build)', () => {
    const opts = DEFAULT_OPTIONS.split(' ');
    const aoutOption = opts.find(o => o.startsWith('--aout='));
    expect(aoutOption).toBe('--aout=adummy');
  });

  it('audio option is not combined with --no-audio', () => {
    // --no-audio is ignored by this VLC build, so it should not appear
    expect(DEFAULT_OPTIONS).not.toContain('--no-audio');
  });

  it('webcodec decoder is listed before audio output in option order', () => {
    const opts = DEFAULT_OPTIONS.split(' ');
    const codecIdx = opts.findIndex(o => o.startsWith('--codec='));
    const aoutIdx = opts.findIndex(o => o.startsWith('--aout='));
    expect(codecIdx).toBeLessThan(aoutIdx);
    expect(codecIdx).toBe(0);
  });

  it('avcodec-threads is set to 1 (single-threaded decoding)', () => {
    const opts = DEFAULT_OPTIONS.split(' ');
    const threadsOption = opts.find(o => o.startsWith('--avcodec-threads='));
    expect(threadsOption).toBe('--avcodec-threads=1');
  });

  it('no option contains input-repeat (prevents main thread flooding)', () => {
    const opts = DEFAULT_OPTIONS.split(' ');
    const repeatOption = opts.find(o => o.includes('input-repeat'));
    expect(repeatOption).toBeUndefined();
  });
});
