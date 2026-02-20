import { describe, it, expect, vi, beforeEach } from 'vitest';

// We can't load the real WASM module in tests, so we mock the Emscripten module
// and test that the JS wrapper calls the correct WASM functions with correct args.

function createMockModule() {
  return {
    _wasm_media_player_new: vi.fn(() => 1001), // fake pointer
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
    _wasm_media_player_set_chapter: vi.fn(),
    _wasm_media_player_get_chapter: vi.fn(() => 2),
    _wasm_media_player_get_chapter_count: vi.fn(() => 10),
    _wasm_media_player_get_chapter_count_for_title: vi.fn(() => 5),
    _wasm_media_player_set_title: vi.fn(),
    _wasm_media_player_get_title: vi.fn(() => 0),
    _wasm_media_player_get_title_count: vi.fn(() => 1),
    _wasm_media_player_previous_chapter: vi.fn(),
    _wasm_media_player_next_chapter: vi.fn(),
    _wasm_media_player_get_rate: vi.fn(() => 1.0),
    _wasm_media_player_set_rate: vi.fn(),
    _wasm_media_player_has_vout: vi.fn(() => 1),
    _wasm_media_player_is_seekable: vi.fn(() => 1),
    _wasm_media_player_can_pause: vi.fn(() => 1),
    _wasm_media_player_program_scrambled: vi.fn(() => 0),
    _wasm_media_player_next_frame: vi.fn(),
    _wasm_media_player_get_role: vi.fn(() => 0),
    _wasm_media_player_set_role: vi.fn(),
    _wasm_video_get_size_x: vi.fn(() => 1920),
    _wasm_video_get_size_y: vi.fn(() => 1080),
    _wasm_video_get_cursor_x: vi.fn(() => 100),
    _wasm_video_get_cursor_y: vi.fn(() => 200),
    _wasm_audio_toggle_mute: vi.fn(),
    _wasm_audio_get_mute: vi.fn(() => 0),
    _wasm_audio_set_mute: vi.fn(),
    _wasm_audio_get_volume: vi.fn(() => 80),
    _wasm_audio_set_volume: vi.fn(),
    _wasm_audio_get_channel: vi.fn(() => 1),
    _wasm_audio_set_channel: vi.fn(),
    _wasm_audio_get_delay: vi.fn(() => 0),
    _wasm_audio_set_delay: vi.fn(),
    _wasm_media_new_location: vi.fn(() => 3001),
    _wasm_media_release: vi.fn(),
    allocateUTF8: vi.fn((str) => 4001), // fake pointer
    _free: vi.fn(),
  };
}

// Dynamic import so jsdom environment is set up first
let MediaPlayer, Media;

beforeEach(async () => {
  const mod = await import('../lib/libvlc.js');
  MediaPlayer = mod.MediaPlayer;
  Media = mod.Media;
});

describe('MediaPlayer', () => {
  let module;

  beforeEach(() => {
    module = createMockModule();
  });

  it('should create a media player and attach events', () => {
    const player = new MediaPlayer(module);
    expect(module._wasm_media_player_new).toHaveBeenCalledOnce();
    expect(module._attach_update_events).toHaveBeenCalledWith(1001);
    expect(player.media_player_ptr).toBe(1001);
  });

  it('should create a media player with initial path', () => {
    const player = new MediaPlayer(module, 'emjsfile://1');
    expect(module._wasm_media_player_new).toHaveBeenCalledOnce();
    expect(module._wasm_media_new_location).toHaveBeenCalled();
    expect(module._wasm_media_player_set_media).toHaveBeenCalled();
    expect(module._wasm_media_release).toHaveBeenCalled(); // media.release() after set
  });

  it('should release the player and zero the pointer', () => {
    const player = new MediaPlayer(module);
    player.release();
    expect(module._wasm_media_player_release).toHaveBeenCalledWith(1001);
    expect(player.media_player_ptr).toBe(0);
  });

  describe('Playback controls', () => {
    it('play() calls the correct WASM function', () => {
      const player = new MediaPlayer(module);
      player.play();
      expect(module._wasm_media_player_play).toHaveBeenCalledWith(1001);
    });

    it('pause() calls the correct WASM function', () => {
      const player = new MediaPlayer(module);
      player.pause();
      expect(module._wasm_media_player_pause).toHaveBeenCalledWith(1001);
    });

    it('stop() calls the correct WASM function', () => {
      const player = new MediaPlayer(module);
      player.stop();
      expect(module._wasm_media_player_stop).toHaveBeenCalledWith(1001);
    });

    it('toggle_play() plays when paused', () => {
      module._wasm_media_player_is_playing.mockReturnValue(0);
      const player = new MediaPlayer(module);
      player.toggle_play();
      expect(module._wasm_media_player_play).toHaveBeenCalledWith(1001);
    });

    it('toggle_play() pauses when playing', () => {
      module._wasm_media_player_is_playing.mockReturnValue(1);
      const player = new MediaPlayer(module);
      player.toggle_play();
      expect(module._wasm_media_player_pause).toHaveBeenCalledWith(1001);
    });
  });

  describe('Time and position', () => {
    it('get_time() returns time from WASM', () => {
      const player = new MediaPlayer(module);
      expect(player.get_time()).toBe(45000);
    });

    it('set_time() passes time and fast flag', () => {
      const player = new MediaPlayer(module);
      player.set_time(60000, true);
      expect(module._wasm_media_player_set_time).toHaveBeenCalledWith(1001, 60000, true);
    });

    it('set_time() defaults fast to false', () => {
      const player = new MediaPlayer(module);
      player.set_time(30000);
      expect(module._wasm_media_player_set_time).toHaveBeenCalledWith(1001, 30000, false);
    });

    it('get_position() returns position from WASM', () => {
      const player = new MediaPlayer(module);
      expect(player.get_position()).toBe(0.375);
    });

    it('get_length() returns duration from WASM', () => {
      const player = new MediaPlayer(module);
      expect(player.get_length()).toBe(120000);
    });
  });

  describe('Chapters', () => {
    it('get_chapter() returns current chapter', () => {
      const player = new MediaPlayer(module);
      expect(player.get_chapter()).toBe(2);
    });

    it('get_chapter_count() returns chapter count', () => {
      const player = new MediaPlayer(module);
      expect(player.get_chapter_count()).toBe(10);
    });

    it('set_chapter() calls WASM with chapter index', () => {
      const player = new MediaPlayer(module);
      player.set_chapter(5);
      expect(module._wasm_media_player_set_chapter).toHaveBeenCalledWith(1001, 5);
    });

    it('next_chapter() and previous_chapter() call WASM', () => {
      const player = new MediaPlayer(module);
      player.next_chapter();
      expect(module._wasm_media_player_next_chapter).toHaveBeenCalledWith(1001);
      player.previous_chapter();
      expect(module._wasm_media_player_previous_chapter).toHaveBeenCalledWith(1001);
    });
  });

  describe('Audio', () => {
    it('get_volume() returns volume from WASM', () => {
      const player = new MediaPlayer(module);
      expect(player.get_volume()).toBe(80);
    });

    it('set_volume() passes volume to WASM', () => {
      const player = new MediaPlayer(module);
      player.set_volume(50);
      expect(module._wasm_audio_set_volume).toHaveBeenCalledWith(1001, 50);
    });

    it('toggle_mute() calls WASM', () => {
      const player = new MediaPlayer(module);
      player.toggle_mute();
      expect(module._wasm_audio_toggle_mute).toHaveBeenCalledWith(1001);
    });

    it('get_mute()/set_mute() call WASM correctly', () => {
      const player = new MediaPlayer(module);
      expect(player.get_mute()).toBe(0);
      player.set_mute(1);
      expect(module._wasm_audio_set_mute).toHaveBeenCalledWith(1001, 1);
    });
  });

  describe('Video info', () => {
    it('get_size() returns video dimensions', () => {
      const player = new MediaPlayer(module);
      expect(player.get_size()).toEqual({ x: 1920, y: 1080 });
    });

    it('get_size() throws when dimensions are -1', () => {
      module._wasm_video_get_size_x.mockReturnValue(-1);
      const player = new MediaPlayer(module);
      expect(() => player.get_size()).toThrow('Cannot get video size');
    });

    it('get_cursor() returns cursor position', () => {
      const player = new MediaPlayer(module);
      expect(player.get_cursor()).toEqual({ x: 100, y: 200 });
    });

    it('get_cursor() throws when values are -1', () => {
      module._wasm_video_get_cursor_x.mockReturnValue(-1);
      const player = new MediaPlayer(module);
      expect(() => player.get_cursor()).toThrow('Cannot get video cursor');
    });
  });

  describe('State queries', () => {
    it('is_seekable() returns WASM value', () => {
      const player = new MediaPlayer(module);
      expect(player.is_seekable()).toBe(1);
    });

    it('can_pause() returns WASM value', () => {
      const player = new MediaPlayer(module);
      expect(player.can_pause()).toBe(1);
    });

    it('has_vout() returns WASM value', () => {
      const player = new MediaPlayer(module);
      expect(player.has_vout()).toBe(1);
    });
  });

  describe('Rate', () => {
    it('get_rate() returns playback rate', () => {
      const player = new MediaPlayer(module);
      expect(player.get_rate()).toBe(1.0);
    });

    it('set_rate() passes rate to WASM', () => {
      const player = new MediaPlayer(module);
      player.set_rate(2.0);
      expect(module._wasm_media_player_set_rate).toHaveBeenCalledWith(1001, 2.0);
    });
  });
});

describe('Media', () => {
  let module;

  beforeEach(() => {
    module = createMockModule();
  });

  it('should create media from a path string', () => {
    const media = new Media(module, 'emjsfile://1');
    expect(module.allocateUTF8).toHaveBeenCalledWith('emjsfile://1');
    expect(module._wasm_media_new_location).toHaveBeenCalledWith(4001);
    expect(module._free).toHaveBeenCalledWith(4001);
    expect(media.media_ptr).toBe(3001);
  });

  it('should create media from a raw pointer', () => {
    const media = new Media(module, null, 9999);
    expect(media.media_ptr).toBe(9999);
    expect(module.allocateUTF8).not.toHaveBeenCalled();
  });

  it('should throw for non-string path', () => {
    expect(() => new Media(module, 123)).toThrow('Tried to create Media with invalid value');
  });

  it('should throw when WASM returns null pointer', () => {
    module._wasm_media_new_location.mockReturnValue(0);
    expect(() => new Media(module, 'bad://path')).toThrow('Could not create media from path');
  });

  it('release() frees the media and zeros the pointer', () => {
    const media = new Media(module, 'emjsfile://1');
    media.release();
    expect(module._wasm_media_release).toHaveBeenCalledWith(3001);
    expect(media.media_ptr).toBe(0);
  });
});
