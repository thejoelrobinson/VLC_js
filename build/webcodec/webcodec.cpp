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
};

extern "C"
{

EMSCRIPTEN_KEEPALIVE picture_t* createAndQueuePicture(decoder_t* dec, int pictureId,
                                                      int64_t timestamp)
{
    auto sys = static_cast<decoder_sys_t*>( dec->p_sys );
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

EM_ASYNC_JS(void, declareCallbacks, (), {
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
    vlc_frame_t* block;

    vlc::threads::mutex_locker lock{ sys->mutex };
    while ( sys->blocks.empty() == false )
    {
        block = sys->blocks.front();
        sys->blocks.pop();

        auto chunk = blockToEncodedVideoChunk( dec, block );
        block_Release(block);
        sys->decoder.call<void>( "decode", chunk );

        auto queueSize = sys->decoder["decodeQueueSize"];
        auto state = sys->decoder["state"];
        msg_Dbg( dec, "Decoder state: %s ; queue size: %ld",
                 state.as<std::string>().c_str(), queueSize.as<long int>());
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
    emscripten_set_main_loop_arg( &WebcodecDecodeWorkerTick, dec, 0, false );
    emscripten_set_main_loop_timing( EM_TIMING_SETTIMEOUT, 1 );
    return NULL;
}

static int Decode( decoder_t* dec, vlc_frame_t* block )
{
    auto sys = static_cast<decoder_sys_t*>( dec->p_sys );
    vlc::threads::mutex_locker lock{ sys->mutex };
    sys->blocks.push( block );
    sys->cond.signal();
    return VLCDEC_SUCCESS;
}

static void Flush( decoder_t* dec )
{
    auto sys = static_cast<decoder_sys_t*>( dec->p_sys );
    // emscripten::val objects have thread affinity — they must be used from
    // the thread that created them. WebcodecDecodeWorker creates sys->decoder
    // (the JS VideoDecoder emval) on the decoder pthread. Calling flush()
    // from a different thread (e.g. VLC's input thread) triggers the
    // "val accessed from wrong thread" assertion in Emscripten 4.0.1.
    // Guard: only call flush if we're on the decoder thread.
    if ( sys->th != 0 && !pthread_equal( sys->th, pthread_self() ) )
    {
        msg_Warn( dec, "webcodec Flush: skipping flush (wrong thread)" );
        return;
    }
    sys->decoder.call<emval>("flush").await();
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
    sys->decoder.call<void>("close");
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
