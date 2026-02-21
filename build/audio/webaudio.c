/*****************************************************************************
 * emscripten.c: Emscripten webaudio output
 *****************************************************************************
 * Copyright © 2022 VLC authors, VideoLAN and Videolabs
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston MA 02110-1301, USA.
 *****************************************************************************/

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdatomic.h>

#include <emscripten.h>
#include <emscripten/threading.h>
#include "webaudio.h"

int webaudio_worklet_push(void *user_data, int8_t *buffer, size_t data_size)
{
    webaudio_buffer_t *sab = (webaudio_buffer_t *) user_data;
    int8_t *sab_view = sab->storage;
    uint32_t head = atomic_load(&sab->head);

    if (head + data_size > STORAGE_SIZE)
    {
        // Copies the part of the data at the buffer end
        unsigned data_size_copy_end = STORAGE_SIZE - head;
        memcpy(sab_view + head, buffer, data_size_copy_end);
        head = 0;

        // Copies the part of the data at the buffer start
        unsigned data_size_copy_start = data_size - data_size_copy_end;
        memcpy(sab_view + head, buffer + data_size_copy_end, data_size_copy_start);
        head = data_size_copy_start;
    }
    else
    {
        memcpy(sab_view + head, buffer, data_size);
        head += data_size;
    }
    // Stores head
    atomic_store(&sab->head, head);
    return 0;
}
