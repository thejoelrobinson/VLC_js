/*****************************************************************************
 * webcodec.cpp: Decoder module using browser provided codec implementations
 *****************************************************************************
 * Copyright © 2021 VLC authors and VideoLAN
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston MA 02110-1301, USA.
 *****************************************************************************/

#ifdef HAVE_CONFIG_H
# include "config.h"
#endif

#include <vlc_common.h>
#include <vlc_plugin.h>
#include <vlc_codec.h>
#include <vlc_threads.h>
#include <vlc_cxx_helpers.hpp>
#include <vlc_block.h>
#include <vlc_tick.h>
#include <vlc_picture.h>

#include "../video_output/emscripten/common.h"

// emscripten.h is kept for EMSCRIPTEN_KEEPALIVE (used on createAndQueuePicture).
// emscripten_set_main_loop_arg and emscripten_cancel_main_loop are no longer
// called — the decoder worker uses vlc_cond_wait instead — but the header is
// harmless and ensures EMSCRIPTEN_KEEPALIVE is available in all Emscripten versions.
#include <emscripten/emscripten.h>

// vlc_fixups.h defines typeof(t) as a macro which breaks emscripten/val.h's
// typeof() method declaration. Undefine it before including val.h.
#ifdef typeof
# undef typeof
#endif
#include <emscripten/val.h>
#include <emscripten/bind.h>
#include <emscripten/em_js.h>
#include <emscripten/wire.h>
#include <memory>
#include <functional>
#include <cstdint>
#include <queue>

using emval = emscripten::val;

struct decoder_sys_t
{
    emval decoder = emval::undefined();
    std::queue<vlc_frame_t*> blocks;
    vlc::threads::mutex mutex;
    vlc::threads::condition_variable cond;
    vlc_thread_t th;

    vlc_video_context* vctx;
    bool sent_first_keyframe = false;

    // Set to true by Close() before it signals the cond and calls vlc_join.
    // WebcodecDecodeWorker checks this flag after every cond_wait wakeup and
    // exits its for(;;) loop, allowing vlc_join to complete without polling.
    // Close() must set exiting and signal the cond while holding the mutex
    // to prevent a lost-wakeup race.
    std::atomic<bool> exiting{false};
};

extern "C"
{

EMSCRIPTEN_KEEPALIVE picture_t* createAndQueuePicture(decoder_t* dec, int pictureId,
                                                      int64_t timestamp)
{
    auto sys = static_cast<decoder_sys_t*>( dec->p_sys );
    // Bail out if Close() is in progress.
    // decoder_UpdateVideoOutput and decoder_QueueVideo access VLC's vout
    // pipeline structures.  VLC tears down the vout concurrently with the
    // decoder at EOS.  Calling these functions during vout teardown accesses
    // partially-freed VLC internal state, corrupting the WASM function table
    // and causing "function signature mismatch" at EOS.
    // exiting is set by Close() BEFORE vlc_join, so it's always visible here
    // while sys itself is still valid (sys is freed AFTER vlc_join returns).
    if ( sys->exiting.load( std::memory_order_acquire ) )
        return NULL;
    if ( decoder_UpdateVideoOutput( dec, sys->vctx ) )
    {
        msg_Err( dec, "Failure during UpdateVideoOutput! FIXME" );
        return NULL;
    }

    auto pic = decoder_NewPicture(dec);
    if (pic == nullptr)
        return nullptr;
    pic->date = VLC_TICK_FROM_US(timestamp);
    pic->b_progressive = true;
    pic->p_sys = reinterpret_cast<void*>( static_cast<uintptr_t>( pictureId ) );
    decoder_QueueVideo(dec, pic);
    return pic;
}

}

EM_JS(void, initModuleContext, (void* ctx), {
    // Use Module (closure var), not globalThis.Module which is only set on main thread
    Module.webCodecCtx = ctx;
});

// EM_JS, not EM_ASYNC_JS: this function contains no top-level await.
// Module.boundOutputCb is defined as an async function (so it returns a Promise
// when invoked) but the DEFINITION itself is synchronous assignment.
//
// Declaring this EM_ASYNC_JS caused ASYNCIFY to instrument the entire call chain:
//   declareCallbacks → initDecoder → WebcodecDecodeWorker
// That changed WebcodecDecodeWorker's WASM type from (i32)->i32 to a different
// signature that the pthread runtime rejected → "function signature mismatch" trap.
// Using EM_JS keeps the type stable and ASYNCIFY out of this call chain entirely.
EM_JS(void, declareCallbacks, (), {
    // Register the MessagePort listener EAGERLY here (not lazily inside boundOutputCb)
    // so the port is captured as soon as interop_emscripten sends it — before any
    // frames are decoded. Uses Emscripten 4.x targetThread routing: the rendering
    // worker sends self.postMessage({targetThread: decoderId, ...}) → main thread
    // routes to PThread.pthreads[decoderId] → this worker's onmessage fires → our
    // addEventListener below receives it.
    Module.voutPort = undefined;
    self.addEventListener('message', function(e) {
        let msg = e['data'];
        if (msg.customCmd == 'transferMessagePort') {
            let port = msg['transferList'][0];
            if (port) Module.voutPort = port;
        }
    });

    Module.pictureId = 0;
    Module.boundOutputCb = async function(frame) {
        // Guard: if the decoder has been closed (tick sets webCodecCtx=0 before
        // emscripten_cancel_main_loop), drop the frame.  Without this, callbacks
        // queued in the JS event loop after Close() fires can call into VLC with
        // a stale/freed decoder pointer → "function signature mismatch" at EOS.
        if (!Module.webCodecCtx) { frame.close(); return; }
        Module.pictureId = (Module.pictureId + 1);
        const pid = Module.pictureId;
        // Queue picture in VLC and deliver frame to main thread via callHandler.
        // callHandler fires on the main thread (where VLC's GL renderer runs)
        // and resolves the promise that bindVideoFrame() is awaiting.
        // frame.timestamp is in microseconds as a JS Number; VLC 4.0 needs BigInt for int64_t.
        _createAndQueuePicture(Module.webCodecCtx, pid, BigInt(Math.round(frame.timestamp)));
        self.postMessage({cmd: 'callHandler', handler: 'vlcOnDecoderFrame', args: [pid, frame]}, [frame]);
    };
    Module.boundErrorCb = function(err) {
        console.log('Error while decoding: ');
        console.log(err);
    };
});

EM_ASYNC_JS(bool, probeConfig, (emscripten::EM_VAL cfg), {
    var decoderCfg = Emval.toValue(cfg);
    var res = await VideoDecoder.isConfigSupported(decoderCfg).catch((err) => {
        console.log(err);
        return {'supported': false};
    });
    return res['supported'];
});

emval blockToEncodedVideoChunk( decoder_t* dec, vlc_frame_t* block )
{
    auto sys = static_cast<decoder_sys_t*>( dec->p_sys );
    auto chunkType = emval::global("EncodedVideoChunk");
    auto chunkCfg = emval::object();

    if ( !sys->sent_first_keyframe )
    {
        chunkCfg.set( "type", "key" );
        sys->sent_first_keyframe = true;
    }
    else
        chunkCfg.set( "type", (block->i_flags & BLOCK_FLAG_TYPE_I) ? "key" : "delta" );
    auto timestamp = block->i_pts ? block->i_pts : block->i_dts;
    chunkCfg.set( "timestamp", (long int)US_FROM_VLC_TICK( timestamp ) );
    chunkCfg.set( "data", emscripten::typed_memory_view( block->i_buffer, block->p_buffer ) );
    return chunkType.new_( std::move( chunkCfg ) );
}

static emval getDecoderConfig( decoder_t* dec, bool includeExtraData )
{
    auto decoderConfig = emval::object();
    switch( dec->fmt_in->i_codec )
    {
    case VLC_CODEC_VP8:
        decoderConfig.set( "codec", "vp8" );
        break;
    case VLC_CODEC_VP9:
        decoderConfig.set( "codec", "vp09.*" );
        break;
    case VLC_CODEC_H264:
    {
        char codec[20];
        int profile = dec->fmt_in->i_profile;
        int level   = dec->fmt_in->i_level;

        // MXF demuxer may not populate i_profile/i_level at Open() time.
        // Parse from AVCC extradata: [0x01][profile][compat][level][...]
        if ( (profile == 0 || level == 0) && dec->fmt_in->i_extra >= 4 )
        {
            const uint8_t* extra = static_cast<const uint8_t*>( dec->fmt_in->p_extra );
            if ( extra[0] == 0x01 )
            {
                profile = extra[1];
                level   = extra[3];
            }
        }

        if ( profile != 0 && level != 0 )
            snprintf( codec, sizeof(codec), "avc1.%.2X%.2X%.2X", profile, 0, level );
        else
        {
            // MXF demuxer may not populate extradata at Open() time.
            // Use H.264 High Profile Level 4.0 as a safe probe fallback.
            // The actual profile is validated by the decoder from the
            // description (AVCC SPS bytes) during configure() in initDecoder().
            msg_Warn( dec, "H.264 profile/level unknown — using High Profile fallback for probe" );
            snprintf( codec, sizeof(codec), "avc1.640028" );
        }

        decoderConfig.set( "codec", codec );
        break;
    }
    case VLC_CODEC_AV1:
        decoderConfig.set( "codec", "av01" );
        break;
    default:
        msg_Warn( dec, "webcodec: unsupported codec FourCC 0x%08x (%4.4s) — falling back to avcodec",
                  dec->fmt_in->i_codec,
                  (const char*)&dec->fmt_in->i_codec );
        return emval::undefined();
    }
    // Only include dimensions if the demuxer has parsed them.
    // MXF demuxers (and some others) report 0x0 at decoder Open() time and
    // populate dimensions after reading the first frame. Passing 0x0 to
    // VideoDecoder.isConfigSupported() causes it to return {supported:false}.
    // Per WebCodecs spec, dimensions can be omitted from the probe config.
    if ( dec->fmt_in->video.i_width > 0 && dec->fmt_in->video.i_height > 0 )
    {
        decoderConfig.set( "codedWidth", dec->fmt_in->video.i_width );
        decoderConfig.set( "codedHeight", dec->fmt_in->video.i_height );
        if ( dec->fmt_in->video.i_visible_width > 0 )
            decoderConfig.set( "displayAspectWidth", dec->fmt_in->video.i_visible_width );
        if ( dec->fmt_in->video.i_visible_height > 0 )
            decoderConfig.set( "displayAspectHeight", dec->fmt_in->video.i_visible_height );
    }
    decoderConfig.set( "optimizeForLatency", true );
    if ( includeExtraData )
    {
        msg_Err( dec, "i_extra: %u", dec->fmt_in->i_extra );
        if ( dec->fmt_in->i_extra > 0 )
        {
            decoderConfig.set( "description",
                               emscripten::typed_memory_view(
                                    dec->fmt_in->i_extra,
                                   static_cast<uint8_t*>( dec->fmt_in->p_extra ) )
                               );
        }
    }
    return decoderConfig;
}

static bool initDecoder( decoder_t* dec )
{
    auto sys = static_cast<decoder_sys_t*>( dec->p_sys );
    sys->sent_first_keyframe = false;
    initModuleContext(dec);
    declareCallbacks();

    auto initCfg = emval::object();

    auto outputCb = emval::module_property("boundOutputCb");
    if ( outputCb.isUndefined() )
    {
        msg_Err( dec, "Failed to find output callback" );
        return false;
    }
    initCfg.set("output", outputCb);

    auto errorCb = emval::module_property("boundErrorCb");
    if ( errorCb.isUndefined() )
    {
        msg_Err( dec, "Failed to find error callback" );
        return false;
    }
    initCfg.set("error", errorCb);

    auto decoderType = emval::global("VideoDecoder");
    sys->decoder = decoderType.new_(initCfg);
    if ( sys->decoder.isUndefined() )
    {
        msg_Err( dec, "Failed to instantiate VideoDecoder" );
        return false;
    }

    sys->decoder.call<void>( "configure", getDecoderConfig( dec, true ) );

    return true;
}

static void WebcodecDecodeWorkerTick( void* arg )
{
    auto dec = static_cast<decoder_t*>( arg );
    auto sys = static_cast<decoder_sys_t*>( dec->p_sys );

    // Close() sets exiting=true then calls vlc_join(sys->th).
    // Cancel the main loop so WebcodecDecodeWorker (ASYNCIFY-suspended) resumes
    // and returns NULL, allowing vlc_join to complete.  After vlc_join returns,
    // Close() frees sys — so we must stop accessing sys before then.
    //
    // NOTE: emval::call() (sys->decoder.call below) MUST be called from the JS
    // event loop (this tick callback), NOT from C++ WASM execution.  Calling
    // emval::call() from an ASYNCIFY-instrumented WASM frame (e.g. a cond_wait
    // loop) triggers a call_indirect type mismatch in Emscripten 4.0.1 because
    // ASYNCIFY's frame bookkeeping conflicts with the emval dispatch table.
    // The tick runs as a JS→C callback, bypassing ASYNCIFY entirely.
    if ( sys->exiting.load(std::memory_order_acquire) )
    {
        // Zero Module.webCodecCtx so any output callbacks still queued in this
        // Worker's event loop see a null context and bail out without calling
        // into VLC's pipeline (which may be concurrently torn down by Close()).
        // createAndQueuePicture also checks sys->exiting as a secondary guard.
        // Note: decoder.close() was removed from here — calling VideoDecoder.close()
        // via emval::call() inside the ASYNCIFY tick callback can corrupt ASYNCIFY's
        // saved stack state for WebcodecDecodeWorker, causing "function signature
        // mismatch" when emscripten_cancel_main_loop() triggers the ASYNCIFY resume.
        initModuleContext( nullptr );
        emscripten_cancel_main_loop();
        return;
    }

    vlc_frame_t* block;
    vlc::threads::mutex_locker lock{ sys->mutex };
    while ( sys->blocks.empty() == false )
    {
        block = sys->blocks.front();
        sys->blocks.pop();

        // Wrap both chunk creation and decode in a try/catch.
        // After a backward seek, the VideoDecoder may be in 'closed' state and
        // VideoDecoder.decode() throws a DOMException.  emval::call() converts that
        // to a C++ exception.  If it escapes this ASYNCIFY tick callback, it
        // corrupts ASYNCIFY's saved stack state for WebcodecDecodeWorker — the next
        // emscripten_cancel_main_loop() resume then hits a call_indirect with a stale
        // type entry → "function signature mismatch" RuntimeError at EOS.
        // Swallowing the exception here is safe: the JS layer (PatchedVideoDecoder in
        // module-loader.js) handles 'closed'-state recovery on the next keyframe.
        try
        {
            auto chunk = blockToEncodedVideoChunk( dec, block );
            block_Release( block );
            block = nullptr;  // mark released so catch does not double-free
            sys->decoder.call<void>( "decode", chunk );
        }
        catch ( ... )
        {
            if ( block != nullptr )
                block_Release( block );  // release if chunk creation threw before block_Release
        }
    }
}

static void* WebcodecDecodeWorker( void* arg )
{
    auto dec = static_cast<decoder_t*>( arg );
    if ( !initDecoder( dec ) )
    {
        msg_Err( dec, "Failed to initialize decoder: FIXME" );
        return NULL;
    }
    auto sys = static_cast<decoder_sys_t*>( dec->p_sys );
    auto vctxPrivate = static_cast<webcodec_context*>(
            vlc_video_context_GetPrivate(sys->vctx, VLC_VIDEO_CONTEXT_WEBCODEC));
    vctxPrivate->decoder_worker = pthread_self();

    // Use simulate_infinite_loop=1 so this pthread BLOCKS here (via ASYNCIFY)
    // until emscripten_cancel_main_loop() is called from within the tick.
    //
    // This keeps the JS Worker "owned" by this pthread for the decoder's
    // lifetime, preventing the Worker-pool recycling race: with
    // simulate_infinite_loop=false the Worker is returned to Emscripten's pool
    // immediately, and a new VLC pthread assigned to it could have its own
    // main loop cancelled by our stale tick → "function signature mismatch".
    //
    // decode calls are made by WebcodecDecodeWorkerTick (the JS event loop
    // callback), NOT from this ASYNCIFY-suspended WASM frame, because
    // emval::call() from an ASYNCIFY-instrumented frame causes a call_indirect
    // type mismatch in Emscripten 4.0.1.  See tick comment above for details.
    //
    // Emscripten 4.0.1 val.h thread-affinity is satisfied: all emval operations
    // execute on this Worker's JS thread (the tick callback and WASM share it).
    emscripten_set_main_loop_arg( &WebcodecDecodeWorkerTick, dec, 1000, 1 );
    return NULL;
}

static int Decode( decoder_t* dec, vlc_frame_t* block )
{
    auto sys = static_cast<decoder_sys_t*>( dec->p_sys );
    if ( block == nullptr )
        return VLCDEC_SUCCESS; // NULL block = EOS signal; handled by Close(), not queued
    vlc::threads::mutex_locker lock{ sys->mutex };
    sys->blocks.push( block );
    sys->cond.signal();
    return VLCDEC_SUCCESS;
}

static void Flush( decoder_t* dec )
{
    // Emscripten 4.0.1 enforces emscripten::val thread affinity: an emval
    // object (sys->decoder, the JS VideoDecoder) can only be used from the
    // pthread that created it (WebcodecDecodeWorker). VLC may call Flush()
    // from the input/demux thread, causing "val accessed from wrong thread"
    // → abort → WASM heap corruption.
    //
    // We cannot call decoder.reset() or decoder.flush() here (wrong thread).
    // Instead:
    //   1. Clear the pending block queue so pre-seek delta frames are not
    //      delivered to the VideoDecoder after the seek point.  Without this,
    //      stale deltas arrive before the IDR, the VideoDecoder enters "closed"
    //      state, and the actual IDR is silently dropped → frozen frame.
    //   2. Reset sent_first_keyframe so the first frame after seek is sent as
    //      type "key", which helps Chrome accept the IDR after any state reset.
    //
    // The JS layer (module-loader.js PatchedVideoDecoder) handles recovery:
    // if the VideoDecoder nonetheless enters "closed" state, it reconfigures
    // automatically on the next keyframe.
    auto sys = static_cast<decoder_sys_t*>( dec->p_sys );
    {
        // Reset keyframe state and discard pre-seek frames under the same lock
        // that WebcodecDecodeWorker holds during blockToEncodedVideoChunk —
        // eliminates the data race on sent_first_keyframe.
        vlc::threads::mutex_locker lock{ sys->mutex };
        sys->sent_first_keyframe = false;  // force key chunk type on next frame
        while ( !sys->blocks.empty() )
        {
            block_Release( sys->blocks.front() );
            sys->blocks.pop();
        }
    }
}

static int Open( vlc_object_t* obj )
{
    auto dec = reinterpret_cast<decoder_t*>(obj);

    msg_Dbg( obj, "webcodec Open() called: cat=%d codec=0x%08x (%4.4s) %ux%u",
             dec->fmt_in->i_cat, dec->fmt_in->i_codec,
             (const char*)&dec->fmt_in->i_codec,
             dec->fmt_in->video.i_width, dec->fmt_in->video.i_height );

    if ( dec->fmt_in->i_cat != VIDEO_ES )
        return VLC_EGENERIC;

    auto decoderType = emval::global("VideoDecoder");
    if ( !decoderType.as<bool>() )
    {
        msg_Err( obj, "Can't get VideoDecoder type, webcodec is probably not "
                      "supported on this browser" );
        return VLC_EGENERIC;
    }
    auto sys = std::make_unique<decoder_sys_t>();
    dec->p_sys = sys.get();

    auto decoderConfig = getDecoderConfig( dec, false );
    if ( decoderConfig.isUndefined() )
        return VLC_EGENERIC;
    auto isSupported = probeConfig(decoderConfig.as_handle());

    if ( isSupported == false )
    {
        msg_Err( dec, "VideoDecoder doesn't support this configuration" );
        return VLC_EGENERIC;
    }

    if ( es_format_Copy( &dec->fmt_out, dec->fmt_in ) != VLC_SUCCESS )
        return VLC_ENOMEM;
    dec->fmt_out.i_codec = dec->fmt_out.video.i_chroma = VLC_CODEC_WEBCODEC_OPAQUE;

    auto dec_dev = decoder_GetDecoderDevice(dec);
    sys->vctx = vlc_video_context_Create(dec_dev, VLC_VIDEO_CONTEXT_WEBCODEC,
                                         sizeof(webcodec_context), nullptr);
    auto vctxPrivate = static_cast<webcodec_context*>(
            vlc_video_context_GetPrivate(sys->vctx, VLC_VIDEO_CONTEXT_WEBCODEC));
    new (vctxPrivate) webcodec_context();

    if ( vlc_clone( &sys->th, &WebcodecDecodeWorker, dec ) != VLC_SUCCESS )
    {
        msg_Err( obj, "Failed to create webcodec thread" );
        return VLC_EGENERIC;
    }

    dec->pf_decode = &Decode;
    dec->pf_flush = &Flush;

    sys.release();
    return VLCDEC_SUCCESS;
}

static void Close( decoder_t* dec )
{
    auto sys = static_cast<decoder_sys_t*>( dec->p_sys );
    // Do NOT call sys->decoder.call<void>("close") here.
    // In Emscripten 4.0.1, emscripten::val has strict thread affinity:
    // sys->decoder (JS VideoDecoder) was created on WebcodecDecodeWorker
    // but Close() is called by VLC's input/demux thread.
    // Calling .call() from the wrong thread triggers:
    //   "val accessed from wrong thread" → abort() → heap corruption.
    // The JS VideoDecoder will be garbage-collected when the emval handle
    // is dropped via the emval destructor (which only calls _emval_decref,
    // a thread-safe reference count decrement — no thread check).

    // Signal the tick to cancel the emscripten main loop.
    // The tick fires every ~1ms; once it sees exiting=true it calls
    // emscripten_cancel_main_loop(), which causes WebcodecDecodeWorker
    // (ASYNCIFY-suspended in simulate_infinite_loop=1) to resume and return NULL.
    sys->exiting.store( true, std::memory_order_release );
    // Wait for the decoder worker thread to exit cleanly.
    // Only after the thread exits do we free sys — no use-after-free possible.
    vlc_join( sys->th, nullptr );
    delete sys;
}

static int
OpenDecDevice(vlc_decoder_device *device, vlc_window_t *)
{
    static const struct vlc_decoder_device_operations ops =
    {
        nullptr,
    };
    device->ops = &ops;
    device->type = VLC_DECODER_DEVICE_WEBCODEC;

    return VLC_SUCCESS;
}

vlc_module_begin ()
    set_description("Video decoder using browser provided implementation")
    set_subcategory(SUBCAT_INPUT_VCODEC)
    set_section(N_("Decoding"), NULL)
    set_capability("video decoder", 100)
    set_callbacks(Open, Close)
    add_shortcut("webcodec")

    add_submodule()
        set_callback_dec_device(OpenDecDevice, 1)
vlc_module_end ()
