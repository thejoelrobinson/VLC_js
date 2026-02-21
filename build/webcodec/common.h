/*****************************************************************************
 * common.h: Emscripten decoder/vout common code
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

#ifndef EMSCRIPTEN_COMMON_H
#define EMSCRIPTEN_COMMON_H

#ifndef __cplusplus
# error This only supports C++
#endif

#include <vlc_threads.h>
#include <vlc_picture.h>

#include <emscripten/html5_webgl.h>

#define WEBCODEC_MAX_PICTURES 32

struct webcodec_context
{
    pthread_t decoder_worker;
};

struct webcodec_picture_sys_t
{
    int pictureId;
};

#endif // EMSCRIPTEN_COMMON_H
