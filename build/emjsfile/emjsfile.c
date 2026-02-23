/*****************************************************************************
 * emjsfile.c: emscripten js file access plugin
 *****************************************************************************
 * Copyright (C) 2022 VLC authors Videolabs, and VideoLAN
 *
 * OPFS fast-read extension (2026): when the file has been pre-copied to the
 * Origin Private File System by the JS layer (lib/opfs-worker.js), VLC reads
 * it via FileSystemSyncAccessHandle.read() instead of Blob.slice() +
 * FileReaderSync.readAsArrayBuffer(). This eliminates the per-read Blob.slice
 * overhead (Emscripten issue #6955) which causes ~several-ms latency per read
 * on Chrome — the dominant bottleneck for MXF header seeking (500-2000ms).
 *
 * Fast path activation: main.js sets Module.vlc_opfs_name[id] = opfsName when
 * the OPFS Worker copy completes. emjsfile passes this to the pthread Worker
 * via the FileResult message. The Worker acquires a FileSystemSyncAccessHandle
 * and uses it for all subsequent synchronous reads.
 *
 * Fallback: if OPFS is unavailable or the file isn't cached, emjsfile falls
 * back transparently to the original FileReaderSync path.
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *****************************************************************************/

#ifdef HAVE_CONFIG_H
# include "config.h"
#endif

#include <vlc_common.h>
#include <vlc_plugin.h>
#include <vlc_access.h>
#include <vlc_threads.h>
#include <stdalign.h>
#include <assert.h>

#include <emscripten.h>

typedef struct
{
    uint64_t offset;
    uint64_t alignas(8) js_file_size;
} access_sys_t;

static ssize_t Read (stream_t *p_access, void *buffer, size_t size) {
    access_sys_t *p_sys = p_access->p_sys;

    size_t offset = p_sys->offset;
    size_t js_file_size = p_sys->js_file_size;

    if (offset >= js_file_size)
        return 0;
    if (size + offset > js_file_size)
        size = js_file_size - offset;

    EM_ASM({
        const offset = $0;
        const buffer = $1;
        const size   = $2;
        const access = Module.vlcAccess[$3];
        if (access.syncHandle) {
            // OPFS fast path: FileSystemSyncAccessHandle.read() — synchronous,
            // sub-millisecond, no Blob.slice() overhead (fixes Emscripten #6955).
            const arr = new Uint8Array(size);
            access.syncHandle.read(arr, { at: offset });
            HEAPU8.set(arr, buffer);
        } else {
            // Fallback: Blob.slice() + FileReaderSync.readAsArrayBuffer()
            const blob = access.worker_js_file.slice(offset, offset + size);
            HEAPU8.set(new Uint8Array(access.reader.readAsArrayBuffer(blob)), buffer);
        }
    }, offset, buffer, size, p_access);

    p_sys->offset += size;
    return size;
}

static int Seek (stream_t *p_access, uint64_t offset) {
    access_sys_t *p_sys = p_access->p_sys;

    p_sys->offset = offset;
    return VLC_SUCCESS;
}

static int get_js_file_size(stream_t *p_access, uint64_t *value) {
    /*
      Note :
      to avoid RangeError on BigUint64 view creation,
      the start offset (value) must be a multiple of 8.
    */
    assert(((uintptr_t)value % 8) == 0);
    return (EM_ASM_INT({
        try {
            var v = new BigUint64Array(wasmMemory.buffer, $0, 1);
            v[0] = BigInt(Module.vlcAccess[$1].worker_js_file.size);
            return 0;
        }
        catch (error) {
            console.error("get_js_file_size error: " + error);
            return 1;
        }
    }, value, p_access) == 0) ? VLC_SUCCESS: VLC_EGENERIC;
}

static int Control( stream_t *p_access, int i_query, va_list args )
{
    bool    *pb_bool;
    vlc_tick_t *pi_64;
    access_sys_t *p_sys = p_access->p_sys;

    switch( i_query )
    {
        case STREAM_CAN_SEEK:
        case STREAM_CAN_FASTSEEK:
            pb_bool = va_arg( args, bool * );
            *pb_bool = true;
            break;

        case STREAM_CAN_PAUSE:
        case STREAM_CAN_CONTROL_PACE:
            pb_bool = va_arg( args, bool * );
            *pb_bool = true;
            break;

        case STREAM_GET_SIZE:
        {
            *va_arg( args, uint64_t * ) = p_sys->js_file_size;
            break;
        }

        case STREAM_GET_PTS_DELAY:
            pi_64 = va_arg( args, vlc_tick_t * );
            *pi_64 = VLC_TICK_FROM_MS(
                var_InheritInteger (p_access, "file-caching") );
            break;

        case STREAM_SET_PAUSE_STATE:
            break;

        default:
            return VLC_EGENERIC;

    }
    return VLC_SUCCESS;
}

EM_ASYNC_JS(int, init_js_file, (stream_t *p_access, long id), {
    let p = new Promise((resolve, reject) => {
        async function handleFileResult(e) {
            const msg = e['data'];
            if (msg.type === 'FileResult') {
                self.removeEventListener('message', handleFileResult);
                if (msg.file !== undefined) {
                    Module.vlcAccess[p_access].worker_js_file = msg.file;
                    Module.vlcAccess[p_access].reader = new FileReaderSync();
                    // OPFS fast path: acquire FileSystemSyncAccessHandle for
                    // synchronous sub-ms reads, eliminating Blob.slice overhead.
                    // Only available when the file has been pre-copied to OPFS
                    // (Module.vlc_opfs_name set by main.js after Worker copy).
                    if (msg.opfsName) {
                        try {
                            const root = await navigator.storage.getDirectory();
                            const dir  = await root.getDirectoryHandle('vlcjs-cache', { create: false });
                            const fh   = await dir.getFileHandle(msg.opfsName, { create: false });
                            // createSyncAccessHandle() is Worker-only and exclusive.
                            // The OPFS copy Worker closes its handle before signalling
                            // completion, so no conflict here.
                            Module.vlcAccess[p_access].syncHandle =
                                await fh.createSyncAccessHandle();
                        } catch (e) {
                            // OPFS unavailable, quota exceeded, or file not yet cached
                            // — fall back to FileReaderSync transparently.
                        }
                    }
                    resolve();
                }
                else {
                    reject("error: sent an undefined File object from the main thread");
                }
            }
            else if (msg.type === 'ErrorVLCAccessFileUndefined') {
                reject("error: vlc_access_file object is not defined");
            }
            else if (msg.type === 'ErrorRequestFileMessageWithoutId') {
                reject("error: request file message send without an id");
            }
            else if (msg.type === 'ErrorMissingFile') {
                reject("error: missing file, bad id or vlc_access_file[id] is not defined");
            }
        }
        self.addEventListener('message', handleFileResult);
    });
    let timer = undefined;
    let timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, 1000, 'timeout');
    });
    let promises = [p, timeout];
    /* id must be unique */
    self.postMessage({ cmd: "customCmd", type: "requestFile", id: id});
    let return_value = 0;
    try {
        let value = await Promise.race(promises);
        if (value === 'timeout') {
            console.error("vlc_access timeout: could not get file!");
            return_value = 1;
        }
    }
    catch(error) {
        console.error("vlc_access error in init_js_file(): ", error);
        return_value = 1;
    }
    clearTimeout(timer);
    return return_value;
});

static void EmFileClose (vlc_object_t * p_this) {
    stream_t *p_access = (stream_t*)p_this;
    EM_ASM({
        // Close OPFS SyncAccessHandle before releasing file reference.
        // Failure to close would leave the exclusive lock held.
        if (Module.vlcAccess[$0].syncHandle) {
            try { Module.vlcAccess[$0].syncHandle.close(); } catch(e) {}
            Module.vlcAccess[$0].syncHandle = undefined;
        }
        Module.vlcAccess[$0].worker_js_file = undefined;
        Module.vlcAccess[$0].reader = undefined;
    }, p_access);
}

static int EmFileOpen( vlc_object_t *p_this ) {
    stream_t *p_access = (stream_t*)p_this;

    /* init per worker module.vlcAccess object */
    /* NOTE: wrap assignment in (...) so the property-separator commas inside the
       JS object literal are protected from C preprocessor macro-argument splitting.
       EM_ASM uses the code block as a variadic macro arg; bare commas (not inside
       () or []) are treated as argument separators by the C preprocessor. */
    EM_ASM({
        if (Module.vlcAccess === undefined) {
            Module.vlcAccess = {};
        }
        (Module.vlcAccess[$0] = {worker_js_file: undefined, reader: undefined, syncHandle: undefined});
    }, p_access);

    /*
      This block will run in the main thread, to access the DOM.
      When the user selects a file, it is assigned to the Module.vlc_access_file
      array.

      We listen to 'message' events so that when the file is requested by the
      input thread, we can answer and send the File object from the main thread.
      We also forward the OPFS filename (if available) so the Worker can open
      a FileSystemSyncAccessHandle for fast synchronous reads.
    */
    MAIN_THREAD_EM_ASM({
        const thread_id = $0;
        let w = Module.PThread.pthreads[thread_id];
        function handleFileRequest(e) {
            const msg = e.data;
            if (msg.type === "requestFile") {
                w.removeEventListener('message', handleFileRequest);
                if (Module.vlc_access_file === undefined) {
                    console.error("vlc_access_file property missing!");
                    w.postMessage({ cmd: "customCmd",
                            type: "ErrorVLCAccessFileUndefined"
                        });
                    return ;
                }
                if (msg.id === undefined) {
                    console.error("id property missing in requestFile message!");
                    w.postMessage({ cmd: "customCmd",
                            type: "ErrorRequestFileMessageWithoutId"
                        });
                    return ;
                }
                if (Module.vlc_access_file[msg.id] === undefined) {
                    console.error("error file missing!");
                    w.postMessage({ cmd: "customCmd",
                            type: "ErrorMissingFile"
                        });
                    return ;
                }
                /*
                  Send both the File object and the OPFS filename (if available).
                  The Worker uses the OPFS filename to open a SyncAccessHandle
                  for fast synchronous reads, bypassing Blob.slice() overhead.
                  Module.vlc_opfs_name is set by main.js when the OPFS copy
                  completes (lib/opfs-worker.js + copyFileToOPFSViaWorker).
                */
                w.postMessage({
                    cmd:      "customCmd",
                    type:     "FileResult",
                    file:     Module.vlc_access_file[msg.id],
                    opfsName: (Module.vlc_opfs_name && Module.vlc_opfs_name[msg.id])
                                ? Module.vlc_opfs_name[msg.id] : undefined,
                });
            }
        }
        w.addEventListener('message', handleFileRequest);
    }, pthread_self());

    char *endPtr;
    long id = strtol(p_access->psz_location, &endPtr, 10);
    if ((endPtr == p_access->psz_location) || (*endPtr != '\0')) {
        msg_Err(p_access, "error: failed init uri has invalid id!");
        return VLC_EGENERIC;
    }

    access_sys_t *p_sys = vlc_obj_malloc(p_this, sizeof (*p_sys));
    if (unlikely(p_sys == NULL))
        return VLC_ENOMEM;

    /*
      Request the file from the main thread.
      If it was not selected, it will return an error.

      To open a file, we need to call libvlc_media_new_location with
      the following uri : emjsfile://<id>
    */
    if (init_js_file(p_access, id)) {
        msg_Err(p_access, "EMJsFile error: failed init!");
        return VLC_EGENERIC;
    }

    p_access->pf_read = Read;
    p_access->pf_block = NULL;
    p_access->pf_control = Control;
    p_access->pf_seek = Seek;
    p_access->p_sys = p_sys;
    p_sys->js_file_size = 0;
    p_sys->offset = 0;
    if (get_js_file_size(p_access, &p_sys->js_file_size)) {
        msg_Err(p_access, "EMJsFile error: could not get file size!");
        EmFileClose(p_this);
        return VLC_EGENERIC;
    }

    return VLC_SUCCESS;
}

vlc_module_begin ()
    set_description( N_("Emscripten module to allow reading local files from the DOM's <input>") )
    set_shortname( N_("Emscripten Local File Input") )
    set_subcategory( SUBCAT_INPUT_ACCESS )
    set_capability( "access", 0 )
    add_shortcut( "emjsfile" )
    set_callbacks( EmFileOpen, EmFileClose )
vlc_module_end()
