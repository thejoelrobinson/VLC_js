#!/bin/bash
# patch_vlcjs_wrappers.sh — Fix vlc.js C wrapper files for VLC 4.0 API changes
#
# The upstream vlc.js wrapper files (exports_media_player.c, exports_media.c)
# were written for VLC 3.x API. VLC 4.0 changed several function signatures:
#
# 1. libvlc_media_player_new_from_media() now requires an instance parameter
# 2. libvlc_audio_get_channel() and libvlc_audio_set_channel() were removed
#
# This script patches the wrapper C files to fix these incompatibilities.

set -e

SRC_DIR="${1:-./src}"
FILE="${SRC_DIR}/exports_media_player.c"

diagnostic() {
    echo "[patch_vlcjs_wrappers] $@" 1>&2
}

if [ ! -f "${FILE}" ]; then
    diagnostic "ERROR: ${FILE} not found"
    exit 1
fi

diagnostic "Patching exports_media_player.c for VLC 4.0 API..."
diagnostic "  Before patching:"
grep -n 'libvlc_media_player_new_from_media\|libvlc_audio_get_channel\|libvlc_audio_set_channel' "${FILE}" || true

# Fix 1: libvlc_media_player_new_from_media needs (instance, media) in VLC 4.0
# The global VLC instance is 'extern libvlc_instance_t *libvlc' from main.c
sed -i 's/libvlc_media_player_new_from_media(media)/libvlc_media_player_new_from_media(libvlc, media)/g' "${FILE}"

# Fix 2: Replace entire function bodies for audio channel get/set
# These functions were removed from VLC 4.0 public API.
# Use python3 for reliable multi-line replacement since sed is fragile.
python3 -c "
import re

with open('${FILE}', 'r') as f:
    content = f.read()

# Replace any line that calls libvlc_audio_get_channel(...) with return 0
content = re.sub(
    r'return\s+libvlc_audio_get_channel\s*\([^)]*\)\s*;',
    'return 0; /* libvlc_audio_get_channel removed in VLC 4.0 */',
    content
)

# Replace any line that calls libvlc_audio_set_channel(...) with return 0
content = re.sub(
    r'return\s+libvlc_audio_set_channel\s*\([^)]*\)\s*;',
    'return 0; /* libvlc_audio_set_channel removed in VLC 4.0 */',
    content
)

# Also handle cases where it's not a return statement
content = re.sub(
    r'libvlc_audio_get_channel\s*\([^)]*\)',
    '0 /* libvlc_audio_get_channel removed in VLC 4.0 */',
    content
)

content = re.sub(
    r'libvlc_audio_set_channel\s*\([^)]*\)',
    '0 /* libvlc_audio_set_channel removed in VLC 4.0 */',
    content
)

with open('${FILE}', 'w') as f:
    f.write(content)
"

diagnostic "  After patching:"
grep -n 'libvlc_media_player_new_from_media\|libvlc_audio_get_channel\|libvlc_audio_set_channel\|removed in VLC 4.0' "${FILE}" || true

# ---- Patch exports_media.c ----
# In VLC 4.0, media creation functions no longer take an instance parameter:
#   libvlc_media_new_path(instance, path) → libvlc_media_new_path(path)
#   libvlc_media_new_location(instance, mrl) → libvlc_media_new_location(mrl)

FILE_MEDIA="${SRC_DIR}/exports_media.c"
if [ -f "${FILE_MEDIA}" ]; then
    diagnostic "Patching exports_media.c for VLC 4.0 API..."
    diagnostic "  Before patching:"
    grep -n 'libvlc_media_new_path\|libvlc_media_new_location' "${FILE_MEDIA}" || true

    # Remove the instance (libvlc) first argument from media creation calls
    sed -i 's/libvlc_media_new_path(libvlc, /libvlc_media_new_path(/g' "${FILE_MEDIA}"
    sed -i 's/libvlc_media_new_location(libvlc, /libvlc_media_new_location(/g' "${FILE_MEDIA}"

    diagnostic "  After patching:"
    grep -n 'libvlc_media_new_path\|libvlc_media_new_location' "${FILE_MEDIA}" || true
fi

# ---- main.c ----
# The iter() deadlock (iter calls libvlc_media_player_get_time which acquires
# vlc_player_Lock on the main browser thread) is now fixed at the JavaScript
# level via --pre-js build/js-patches/cancel-main-loop.js, which cancels the
# Emscripten main loop via factory-scope closure access after VLC initializes.
# No C-level patch to main.c is needed.

diagnostic "All patches applied successfully."
