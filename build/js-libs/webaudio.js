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

mergeInto(LibraryManager.library, {
    webaudio_getSampleRate: function() {
        if (Module.webaudioContext === undefined)
            return 0;
        return Module.webaudioContext.sampleRate;
    },
    webaudio_getChannels: function() {
        if (Module.webaudioContext === undefined)
            return 0;
        return Module.webaudioContext.destination.channelCount;
    },
    webaudio_init: async function (rate, channels, webaudio_buffer, latency) {
        /*
          [mainThread]
          - create the audio context
          - set rate and channel numbers
          - setup the AudioWorkletNode and workler
        */
        const STORAGE_SIZE = 1024 * 1024;
        const STRUCT_SIZE = 20;
	if (latency === 0) {
	    latency = "playback";
	}
	else if (latency === 1) {
	    latency = "interactive";
	}
	else if (latency === 2) {
	    latency = "balanced";
	}
	else {
	    console.error("error: bad latency setting!");
	    return ;
	}
        var audioCtx = new AudioContext({
            latencyHint: latency,
            sampleRate: rate
        });
        audioCtx.suspend();
        Module.webaudioContext = audioCtx;

        var msg = {};
        msg["type"] = "recv-audio-queue";

        msg["is_paused"] = new Int32Array(wasmMemory.buffer, webaudio_buffer, 1);
        msg["is_paused"][0] = 0;
        // sizeof(type) * length
        webaudio_buffer += 4

        msg["head"] = new Int32Array(wasmMemory.buffer, webaudio_buffer, 1);
        webaudio_buffer += 4

        msg["tail"] = new Int32Array(wasmMemory.buffer, webaudio_buffer, 1);
        webaudio_buffer += 4

        msg["can_write"] = new Int32Array(wasmMemory.buffer, webaudio_buffer, 1)
        msg["can_write"][0] = 1;
        webaudio_buffer += 4

        msg["storage"] = new Float32Array(wasmMemory.buffer, webaudio_buffer, STORAGE_SIZE / 4);

        if (audioCtx.sampleRate != rate) {
            console.error("desired rate unsupported by the browser, actual sample rate is: " + audioCtx.sampleRate);
        }

        if (audioCtx.destination.maxChannelCount < channels) {
            console.error("Max number of channels of the browser is ", audioCtx.destination.maxChannelCount)
            channels = audioCtx.destination.maxChannelCount;
        }

        try {
            await audioCtx.audioWorklet.addModule('./audio-worklet-processor.js');
        } catch (error){
            console.error('could not add worklet module error: ' + error);
	    return ;
        }

        const node = new AudioWorkletNode(audioCtx, 'worklet-processor', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [channels]
        });

        var resolvePromise, rejectPromise;
        var p = new Promise(function(resolve, reject) {
	    node["port"].onmessage = function(e) {
		console.log("successfully constructed AudioWorkletProcessor");
		if (e.data === "ready") {
		    resolve();
		}
		else if (e.data === "error") {
		    reject();
		    return ;
		}
            }
        });
        node["port"].postMessage(msg);
        await p;

        node.connect(audioCtx.destination);
        audioCtx.resume();
    },
})
