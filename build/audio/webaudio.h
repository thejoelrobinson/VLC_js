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

#ifndef WEBAUDIO_H
#define WEBAUDIO_H

#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <stdatomic.h>

#define STORAGE_SIZE 1024 * 1024
#define ATOMIC_WAIT_TIMEOUT 5000

typedef struct sound_buffer_t {
    _Atomic uint32_t is_paused;
    _Atomic uint32_t head;
    _Atomic uint32_t tail;
    _Atomic uint32_t can_write;
    int8_t storage[STORAGE_SIZE];
} webaudio_buffer_t;

typedef enum indexes {
    IS_PAUSED,
    HEAD,
    TAIL,
    CAN_WRITE,
    STORAGE,
} indexes;

typedef enum latency_hint {
    // minimum power consumption, but high latency
    WEBAUDIO_LATENCY_PLAYBACK,
    // minimum latency, but high power consumption
    WEBAUDIO_LATENCY_INTERACTIVE,
    // best latency + power consumption mix
    WEBAUDIO_LATENCY_BALANCED,
} latency_hint;

extern int webaudio_getSampleRate(void);
extern int webaudio_getChannels(void);
extern void webaudio_init(int rate, int channels, webaudio_buffer_t *buffer, latency_hint latency);
int webaudio_worklet_push(void *user_data, int8_t *buffer, size_t data_size);

#endif /*WEBAUDIO_H*/
