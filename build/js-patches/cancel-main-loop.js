// Cancel Emscripten's emscripten_set_main_loop() timer after VLC initializes.
//
// Problem: main.c registers iter() as a 1fps main-loop callback via
//   emscripten_set_main_loop(iter, 1, 0).
// iter() calls libvlc_media_player_get_time(mp) which acquires vlc_player_Lock.
// On the main browser thread with ASYNCIFY, this "fake-blocks" the thread.
// At end-of-stream, VLC's cleanup thread holds vlc_player_Lock while waiting
// for the main thread to process a synchronous GL proxy call → ASYNCIFY
// deadlock → permanent page freeze.
//
// Fix: after onRuntimeInitialized fires and main() has run (which sets up
// the loop), cancel the main loop via factory-scope variables.
// This --pre-js file runs inside the Emscripten module factory function, so
// _emscripten_cancel_main_loop and MainLoop are accessible via closure once
// defined later in the same factory scope.
//
// The runtime stays alive via emscripten_exit_with_live_runtime() which
// main.c already calls — cancelling the loop does not stop VLC.
//
// CRITICAL: Only cancel on the MAIN browser thread (ENVIRONMENT_IS_PTHREAD = false).
// Emscripten's pthread workers also call the factory and also have a MainLoop.
// In workers, MainLoop drives the internal Emscripten task/proxy queue (receiving
// inter-thread messages, GL proxy calls, etc.). Cancelling it in a worker breaks
// all inter-thread communication, causing RuntimeError: function signature mismatch
// when the decoder worker can't receive GL proxy responses from the main thread.

const _origOnRTI = moduleArg.onRuntimeInitialized || function(){};
moduleArg.onRuntimeInitialized = function() {
  _origOnRTI.call(this);

  // ENVIRONMENT_IS_PTHREAD is set in the factory before onRuntimeInitialized fires.
  // Skip the cancel entirely in pthread workers — they need their MainLoop.
  if (ENVIRONMENT_IS_PTHREAD) {
    return;
  }

  // main() runs synchronously after onRuntimeInitialized returns.
  // It calls emscripten_set_main_loop(iter, 1, 0) which sets MainLoop.func.
  // Defer our cancel by one task-queue turn to run after main() completes.
  setTimeout(function() {
    try {
      if (typeof _emscripten_cancel_main_loop === 'function') {
        _emscripten_cancel_main_loop();
        console.log('[vlcjs] Emscripten main loop cancelled — EOS deadlock fix');
      } else if (typeof MainLoop !== 'undefined' && MainLoop !== null) {
        if (typeof MainLoop.pause === 'function') MainLoop.pause();
        MainLoop.func = null;
        console.log('[vlcjs] Emscripten MainLoop paused directly — EOS deadlock fix');
      }
    } catch(e) {
      console.warn('[vlcjs] Could not cancel main loop:', e);
    }
  }, 0);
};
