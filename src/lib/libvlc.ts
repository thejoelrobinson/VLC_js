// Encapsulate functions exported from exports_*.c

// Encapsulates libvlc_media_player_t
export class MediaPlayer {
  private module: VlcModule;
  media_player_ptr: number;

  constructor(module: VlcModule, path: string | null) {
    this.module = module;
    this.media_player_ptr = module._wasm_media_player_new();
    module._attach_update_events(this.media_player_ptr);

    if (path != null) {
      const media = new Media(module, path);
      this.set_media(media);
      media.release();
    }
  }

  release(): void {
    this.module._wasm_media_player_release(this.media_player_ptr);
    this.media_player_ptr = 0;
  }

  set_media(media: Media): void {
    this.module._wasm_media_player_set_media(this.media_player_ptr, media.media_ptr);
  }

  get_media(): Media {
    const media_ptr = this.module._wasm_media_player_get_media(this.media_player_ptr);
    this.module._wasm_media_retain(media_ptr);
    // Build from raw ptr
    return new Media(this.module, null, media_ptr);
  }

  toggle_play(): void {
    if (!this.is_playing()) {
      this.play();
    } else {
      this.pause();
    }
  }

  is_playing(): number {
    return this.module._wasm_media_player_is_playing(this.media_player_ptr);
  }

  stop(): number {
    return this.module._wasm_media_player_stop(this.media_player_ptr);
  }

  play(): number {
    return this.module._wasm_media_player_play(this.media_player_ptr);
  }

  set_pause(do_pause: number): number {
    return this.module._wasm_media_player_set_pause(this.media_player_ptr, do_pause);
  }

  pause(): void {
    return this.module._wasm_media_player_pause(this.media_player_ptr);
  }

  get_length(): number {
    return this.module._wasm_media_player_get_length(this.media_player_ptr);
  }

  get_time(): number {
    return this.module._wasm_media_player_get_time(this.media_player_ptr);
  }

  set_time(time: number, fast = false): number {
    return this.module._wasm_media_player_set_time(this.media_player_ptr, time, fast);
  }

  get_position(): number {
    return this.module._wasm_media_player_get_position(this.media_player_ptr);
  }

  set_position(position: number, fast = false): number {
    return this.module._wasm_media_player_set_position(this.media_player_ptr, position, fast);
  }

  set_chapter(chapter: number): void {
    this.module._wasm_media_player_set_chapter(this.media_player_ptr, chapter);
  }

  get_chapter(): number {
    return this.module._wasm_media_player_get_chapter(this.media_player_ptr);
  }

  get_chapter_count(): number {
    return this.module._wasm_media_player_get_chapter_count(this.media_player_ptr);
  }

  get_chapter_count_for_title(title: number): number {
    return this.module._wasm_media_player_get_chapter_count_for_title(this.media_player_ptr, title);
  }

  set_title(title: number): void {
    this.module._wasm_media_player_set_title(this.media_player_ptr, title);
  }

  get_title(): number {
    return this.module._wasm_media_player_get_title(this.media_player_ptr);
  }

  get_title_count(): number {
    return this.module._wasm_media_player_get_title_count(this.media_player_ptr);
  }

  previous_chapter(): void {
    return this.module._wasm_media_player_previous_chapter(this.media_player_ptr);
  }

  next_chapter(): void {
    return this.module._wasm_media_player_next_chapter(this.media_player_ptr);
  }

  get_rate(): number {
    return this.module._wasm_media_player_get_rate(this.media_player_ptr);
  }

  set_rate(rate: number): number {
    return this.module._wasm_media_player_set_rate(this.media_player_ptr, rate);
  }

  has_vout(): number {
    return this.module._wasm_media_player_has_vout(this.media_player_ptr);
  }

  is_seekable(): number {
    return this.module._wasm_media_player_is_seekable(this.media_player_ptr);
  }

  can_pause(): number {
    return this.module._wasm_media_player_can_pause(this.media_player_ptr);
  }

  program_scrambled(): number {
    return this.module._wasm_media_player_program_scrambled(this.media_player_ptr);
  }

  next_frame(): number {
    return this.module._wasm_media_player_next_frame(this.media_player_ptr);
  }

  get_size(): { x: number; y: number } {
    const x = this.module._wasm_video_get_size_x(this.media_player_ptr);
    const y = this.module._wasm_video_get_size_y(this.media_player_ptr);

    if (x === -1 || y === -1) {
      throw new Error("Cannot get video size");
    }

    return { x, y };
  }

  get_cursor(): { x: number; y: number } {
    const x = this.module._wasm_video_get_cursor_x(this.media_player_ptr);
    const y = this.module._wasm_video_get_cursor_y(this.media_player_ptr);

    if (x === -1 || y === -1) {
      throw new Error("Cannot get video cursor");
    }

    return { x, y };
  }

  toggle_mute(): void {
    this.module._wasm_audio_toggle_mute(this.media_player_ptr);
  }

  get_mute(): number {
    return this.module._wasm_audio_get_mute(this.media_player_ptr);
  }

  set_mute(mute: number): void {
    this.module._wasm_audio_set_mute(this.media_player_ptr, mute);
  }

  get_volume(): number {
    return this.module._wasm_audio_get_volume(this.media_player_ptr);
  }

  set_volume(volume: number): number {
    return this.module._wasm_audio_set_volume(this.media_player_ptr, volume);
  }

  get_channel(): number {
    return this.module._wasm_audio_get_channel(this.media_player_ptr);
  }

  set_channel(channel: number): number {
    return this.module._wasm_audio_set_channel(this.media_player_ptr, channel);
  }

  get_delay(): number {
    return this.module._wasm_audio_get_delay(this.media_player_ptr);
  }

  set_delay(delay: number): number {
    return this.module._wasm_audio_set_delay(this.media_player_ptr, delay);
  }

  get_role(): number {
    return this.module._wasm_media_player_get_role(this.media_player_ptr);
  }

  set_role(role: number): number {
    return this.module._wasm_media_player_set_role(this.media_player_ptr, role);
  }
}


// Encapsulates libvlc_media_t
export class Media {
  private module: VlcModule;
  media_ptr: number;

  constructor(module: VlcModule, path: string | null, rawPtr?: number) {
    if (rawPtr != null) {
      this.module = module;
      this.media_ptr = rawPtr;
      return;
    }

    if (typeof path !== 'string') {
      throw new Error("Tried to create Media with invalid value");
    }

    this.module = module;

    const path_ptr = module.allocateUTF8(path);
    this.media_ptr = module._wasm_media_new_location(path_ptr);
    module._free(path_ptr);

    if (this.media_ptr === 0) {
      throw new Error(`Could not create media from path ${path}`);
    }
  }

  release(): void {
    this.module._wasm_media_release(this.media_ptr);
    this.media_ptr = 0;
  }
}
