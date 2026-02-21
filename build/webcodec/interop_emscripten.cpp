/*****************************************************************************
 * interop_emscripten.cpp: OpenGL Emscripten/Webcodec opaque converter
 *****************************************************************************
 * Copyright (C) 2021 VLC authors and VideoLAN
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston MA 02110-1301, USA.
 *****************************************************************************/

#ifdef HAVE_CONFIG_H
# include "config.h"
#endif

#include <vlc_common.h>
#include <vlc_plugin.h>
#include "interop.h"
#include "gl_common.h"
#include <cassert>
#include "../emscripten/common.h"

#include <emscripten.h>
#include <emscripten/em_js.h>
// vlc_fixups.h defines typeof(t) as a macro which breaks emscripten/val.h
#ifdef typeof
# undef typeof
#endif
#include <emscripten/val.h>
#include <emscripten/html5_webgl.h>

struct EmscriptenInterop
{
    struct
    {
        PFNGLBINDTEXTUREPROC BindTexture;
    } gl;
};

static int
tc_emscripten_op_allocate_textures(const struct vlc_gl_interop *interop,
                                   uint32_t textures[],
                                   const int32_t tex_width[],
                                   const int32_t tex_height[])
{
    (void) tex_width; (void) tex_height;
    assert(textures[0] != 0);

    return VLC_SUCCESS;
}

EM_ASYNC_JS(void, bindVideoFrame, (int pictureId), {
    let frame = await Module.awaitFrame(pictureId);

    let glCtx = Module.glCtx;
    glCtx.texImage2D(glCtx.TEXTURE_2D, 0, glCtx.RGBA, frame.codedWidth, frame.codedHeight, 0,
                glCtx.RGBA, glCtx.UNSIGNED_BYTE, frame);
})

static int
tc_emscripten_op_update(const struct vlc_gl_interop *interop,
                        uint32_t textures[],
                        const int32_t tex_width[],
                        const int32_t tex_height[],
                        picture_t *pic,
                        const size_t plane_offsets[])
{
    auto sys = static_cast<EmscriptenInterop *>( interop->priv );

    sys->gl.BindTexture(interop->tex_target, textures[0]);

    auto pictureId = reinterpret_cast<uintptr_t>( pic->p_sys );
    bindVideoFrame(pictureId);

    return VLC_SUCCESS;
}

extern "C"
{
EMSCRIPTEN_KEEPALIVE int getDecoderWorker(vlc_video_context* vctx)
{
    auto wcCtx = static_cast<webcodec_context*>(
                vlc_video_context_GetPrivate(vctx, VLC_VIDEO_CONTEXT_WEBCODEC));
    if (!wcCtx)
        return 0;
    return wcCtx->decoder_worker;
}
}

EM_JS(void, transferMessagePort, (vlc_video_context* vctx), {
    function onDecoderMessage(msg) {
        let data = msg['data'];
        if (data.customCmd == 'displayFrame') {
            let pictureId = data.pictureId;
            let pictureIdx = pictureId % 32;
            let frame = data['frame'];
            if ( Module.glConv.promiseResolvers[pictureIdx] ) {
                Module.glConv.promiseResolvers[pictureIdx]( frame );
            } else {
                Module.glConv.frameQueue[pictureIdx] = frame;
            }
        }
    };
    Module.msgChannel = new MessageChannel();
    Module.msgChannel.port1.onmessage = onDecoderMessage;
    // Retry loop: decoder_worker is set by WebcodecDecodeWorker->pthread_self()
    // which runs on a NEW thread. interop Open() may fire before that thread has
    // called pthread_self(), so _getDecoderWorker() may return 0. Retry with
    // setTimeout until the worker ID is populated.
    function tryTransfer() {
        let workerId = _getDecoderWorker(vctx);
        if (workerId == 0) {
            setTimeout(tryTransfer, 50);
            return;
        }
        // In Emscripten 4.0.1, PThread.pthreads is only populated on the main thread.
        // Calling worker.postMessage() directly from a rendering worker fails.
        // Instead, use Emscripten's built-in targetThread routing:
        //   self.postMessage({targetThread: id, ...}, transferList)
        // → main thread's worker.onmessage routes to PThread.pthreads[id].postMessage()
        // → decoder worker's self.onmessage + self.addEventListener fire.
        self.postMessage({
            targetThread: workerId,
            customCmd: 'transferMessagePort',
            transferList: [Module.msgChannel.port2],
        }, [Module.msgChannel.port2]);
    }
    tryTransfer();
});

EM_JS(void, initGlConvWorker, (int maxPictures), {
    Module.glConv = {};
    Module.glConv.promiseResolvers = [];
    Module.glConv.frameQueue = [];
    Module.glConv.lastFrame = {
        pictureId: -1,
        frame: undefined
    };

    Module.awaitFrame = async function(pictureId) {
        if (Module.glConv.lastFrame.pictureId == pictureId) {
            return Module.glConv.lastFrame.frame;
        }
        let pictureIndex = pictureId % 32;
        let p = new Promise((resolve, reject) => {
            if ( Module.glConv.frameQueue[pictureIndex] ) {
                let frame = Module.glConv.frameQueue[pictureIndex];
                resolve(frame);
                Module.glConv.frameQueue[pictureIndex] = undefined;
            } else {
                Module.glConv.promiseResolvers[pictureIndex] = resolve;
            }
        });
        let frame = await p;
        Module.glConv.promiseResolvers[pictureId] = undefined;
        if (Module.glConv.lastFrame.frame)
            Module.glConv.lastFrame.frame.close();
        Module.glConv.lastFrame.frame = frame;
        Module.glConv.lastFrame.pictureId = pictureId;
        return frame;
    }
})

EM_JS(void, closeMessagePort, (void), {
    if (Module.msgChannel)
        delete Module.msgChannel;
});

static void
Close(struct vlc_gl_interop *interop)
{
    (void) interop;
    closeMessagePort();
}

static int
Open(struct vlc_gl_interop *interop)
{
    if (interop->fmt_in.i_chroma != VLC_CODEC_WEBCODEC_OPAQUE)
        return VLC_EGENERIC;

    EmscriptenInterop *sys = (EmscriptenInterop *)
        vlc_obj_malloc(VLC_OBJECT(interop), sizeof(*sys));
    if (sys == NULL)
        return VLC_EGENERIC;
    sys->gl.BindTexture = (PFNGLBINDTEXTUREPROC)
        vlc_gl_GetProcAddress(interop->gl, "glBindTexture");
    if (sys->gl.BindTexture == NULL)
        return VLC_EGENERIC;

    static const struct vlc_gl_interop_ops ops = {
        .allocate_textures = tc_emscripten_op_allocate_textures,
        .update_textures = tc_emscripten_op_update,
        .close = Close,
    };
    interop->ops = &ops;
    initGlConvWorker(WEBCODEC_MAX_PICTURES);
    transferMessagePort(interop->vctx);

    interop->tex_target = GL_TEXTURE_2D;
    interop->fmt_out.i_chroma = VLC_CODEC_RGBA;
    interop->fmt_out.space = COLOR_SPACE_UNDEF;
    interop->tex_count = 1;
    interop->texs[0] = vlc_gl_interop::vlc_gl_tex_cfg{
            /*.w =*/ { 1, 1 },
            /*.h =*/ { 1, 1 },
            /*.internal =*/ GL_RGBA,
            /*.format = */GL_RGBA,
            /*.type = */GL_UNSIGNED_BYTE,
    };
    interop->priv = sys;

    interop->fmt_out.orientation = ORIENT_VFLIPPED;

    return VLC_SUCCESS;
}

vlc_module_begin ()
    set_description("Emscripten OpenGL WebCodec converter")
    set_capability("glinterop", 1)
    set_callback(Open)
    set_subcategory(SUBCAT_VIDEO_VOUT)
vlc_module_end ()
