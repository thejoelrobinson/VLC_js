// Global type declarations for VLC.js
// Types defined here are available in all TypeScript source files without import.

export {};

declare global {
  // ---- VLC WASM module interface ----
  // All WASM function calls go through this interface.
  // Pointers are plain JS numbers (C address space mapped to WASM linear memory).
  interface VlcModule {
    // Emscripten runtime helpers
    _malloc(size: number): number;
    _free(ptr: number): void;
    allocateUTF8(str: string): number;
    writeAsciiToMemory(str: string, buffer: number, dontAddNull: boolean): void;
    wasmMemory: WebAssembly.Memory;
    PThread: unknown;

    // Module-level properties (set by vlcjs glue and module-loader.js)
    vlc_access_file: Record<number, File>;
    glConv?: {
      frameQueue: Record<number, VideoFrame>;
      promiseResolvers: Record<number, (frame: VideoFrame) => void>;
    };
    setStatus(text: string): void;
    printErr(...args: unknown[]): void;

    // ---- libvlc initialization ----
    _wasm_libvlc_init(argc: number, argv: number): void;

    // ---- libvlc media player ----
    _wasm_media_player_new(): number;
    _attach_update_events(ptr: number): void;
    _wasm_media_player_release(ptr: number): void;
    _wasm_media_player_set_media(playerPtr: number, mediaPtr: number): void;
    _wasm_media_player_get_media(playerPtr: number): number;
    _wasm_media_retain(ptr: number): void;
    _wasm_media_player_is_playing(ptr: number): number;
    _wasm_media_player_stop(ptr: number): number;
    _wasm_media_player_play(ptr: number): number;
    _wasm_media_player_pause(ptr: number): void;
    _wasm_media_player_set_pause(ptr: number, doPause: number): number;
    _wasm_media_player_get_length(ptr: number): number;
    _wasm_media_player_get_time(ptr: number): number;
    _wasm_media_player_set_time(ptr: number, time: number, fast: boolean): number;
    _wasm_media_player_get_position(ptr: number): number;
    _wasm_media_player_set_position(ptr: number, position: number, fast: boolean): number;
    _wasm_media_player_set_chapter(ptr: number, chapter: number): void;
    _wasm_media_player_get_chapter(ptr: number): number;
    _wasm_media_player_get_chapter_count(ptr: number): number;
    _wasm_media_player_get_chapter_count_for_title(ptr: number, title: number): number;
    _wasm_media_player_set_title(ptr: number, title: number): void;
    _wasm_media_player_get_title(ptr: number): number;
    _wasm_media_player_get_title_count(ptr: number): number;
    _wasm_media_player_previous_chapter(ptr: number): void;
    _wasm_media_player_next_chapter(ptr: number): void;
    _wasm_media_player_get_rate(ptr: number): number;
    _wasm_media_player_set_rate(ptr: number, rate: number): number;
    _wasm_media_player_has_vout(ptr: number): number;
    _wasm_media_player_is_seekable(ptr: number): number;
    _wasm_media_player_can_pause(ptr: number): number;
    _wasm_media_player_program_scrambled(ptr: number): number;
    _wasm_media_player_next_frame(ptr: number): number;
    _wasm_media_player_get_role(ptr: number): number;
    _wasm_media_player_set_role(ptr: number, role: number): number;

    // ---- libvlc video ----
    _wasm_video_get_size_x(ptr: number): number;
    _wasm_video_get_size_y(ptr: number): number;
    _wasm_video_get_cursor_x(ptr: number): number;
    _wasm_video_get_cursor_y(ptr: number): number;

    // ---- libvlc audio ----
    _wasm_audio_toggle_mute(ptr: number): void;
    _wasm_audio_get_mute(ptr: number): number;
    _wasm_audio_set_mute(ptr: number, mute: number): void;
    _wasm_audio_get_volume(ptr: number): number;
    _wasm_audio_set_volume(ptr: number, volume: number): number;
    _wasm_audio_get_channel(ptr: number): number;
    _wasm_audio_set_channel(ptr: number, channel: number): number;
    _wasm_audio_get_delay(ptr: number): number;
    _wasm_audio_set_delay(ptr: number, delay: number): number;

    // ---- vlcjs wrapper exports ----
    _set_global_media_player(ptr: number): void;
    _wasm_media_new_location(pathPtr: number): number;
    _wasm_media_release(ptr: number): void;
  }

  // ---- State cache written by module-loader and libvlc, read by overlay ----
  // Avoids calling VLC 4.0 WASM functions from main thread (they acquire
  // vlc_player_Lock → pthread_cond_timedwait → blocks browser main thread).
  interface VlcStateCache {
    position: number;    // playback position 0.0–1.0
    timeMs: number;      // current time in milliseconds
    lengthMs: number;    // total duration in milliseconds
    volume: number;      // volume 0–100
    muted: boolean;
    chapter: number;
    chapterCount: number;
  }

  // ---- Emscripten module configuration object ----
  // Passed to initModule() to configure the WASM runtime.
  interface VlcModuleConfig {
    preRun: Array<() => void>;
    vlc_access_file: Record<number, File>;
    vlcOnDecoderFrame: (pictureId: number, frame: VideoFrame) => void;
    vlcSetRenderPort1: (port: MessagePort) => void;
    onRuntimeInitialized: () => void;
    print: (...args: unknown[]) => void;
    printErr: (...args: unknown[]) => void;
    canvas: HTMLCanvasElement;
    setStatus: (text: string) => void;
    totalDependencies: number;
    monitorRunDependencies: (left: number) => void;
  }

  // ---- Globals from experimental.js (Emscripten-generated classic script) ----
  function initModule(config: Partial<VlcModuleConfig>): Promise<VlcModule>;

  // ---- Globals from module-loader.js (classic script) ----
  // VlcModuleExt is defined with `var` in module-loader.ts so it merges here.
  var VlcModuleExt: VlcModuleConfig;
  // DOM elements and CustomEvents shared between module-loader.js and main.js
  var body: HTMLElement;
  var isLoading: CustomEvent<{ loading: boolean }>;
  var isNotLoading: CustomEvent<{ loading: boolean }>;
  var spinnerElement: HTMLElement | null;
  var overlayElement: HTMLElement | null;
  var spinnerLdsElement: HTMLElement | null;

  // ---- window.* VLC runtime state ----
  interface Window {
    // Emscripten module instance (assigned in main.ts after initModule resolves)
    Module: VlcModule;
    // Legacy display flag checked by VLC preRun
    display_overlay?: boolean;
    // File(s) selected by the user
    files: FileList | null;
    // MediaPlayer instance created in main.ts
    media_player: import('../lib/libvlc').MediaPlayer | null;
    // Cached playing state — avoids calling is_playing() on main thread
    _vlcIsPlaying: boolean;
    // Cached VLC state for overlay UI (position, time, volume, etc.)
    _vlcStateCache?: VlcStateCache;
    // WebCodecs frame callbacks (set by module-loader.ts)
    _vlcOnDecoderFrame: (pictureId: number, frame: VideoFrame) => void;
    _vlcSetRenderPort1: (port: MessagePort) => void;
    _vlcAwaitFrame: (pictureId: number) => Promise<VideoFrame>;
    // Overlay callbacks (set by main.ts for use in vlc.html onclick)
    on_overlay_click: (mouseEvent: MouseEvent) => void;
    update_overlay: () => void;
  }
}
