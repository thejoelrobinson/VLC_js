// OPFS (Origin Private File System) support for VLC.js
// Copies user-selected files to OPFS for faster random access during playback.
// Falls back silently to the original File if OPFS is unavailable or errors occur.

const OPFS_DIR_NAME = "vlcjs-cache";
const CHUNK_SIZE = 1024 * 1024; // 1 MB copy chunks

/**
 * Check whether the OPFS API is available in this browser.
 */
export function isOPFSSupported(): boolean {
  return typeof navigator !== "undefined"
    && typeof navigator.storage !== "undefined"
    && typeof navigator.storage.getDirectory === "function";
}

/**
 * Build a fingerprint key for a File so we can detect cache hits across sessions.
 * Uses name + size + lastModified to avoid expensive hashing.
 */
function cacheKey(file: File): string {
  return `opfs_cache_${file.name}_${file.size}_${file.lastModified}`;
}

/**
 * Look up a previously cached OPFS copy of this file.
 * Returns an OPFS-backed File if found, or null.
 */
export async function getCachedOPFSFile(file: File): Promise<File | null> {
  try {
    const stored = localStorage.getItem(cacheKey(file));
    if (!stored) return null;

    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR_NAME, { create: false });
    const handle = await dir.getFileHandle(stored, { create: false });
    const opfsFile = await handle.getFile();

    // Sanity check: size must match
    if (opfsFile.size !== file.size) {
      // Stale cache entry — remove it
      localStorage.removeItem(cacheKey(file));
      return null;
    }

    return opfsFile;
  } catch {
    // Directory or file doesn't exist, or any other error
    return null;
  }
}

/**
 * Copy a File to OPFS in 1 MB chunks with progress reporting.
 * Returns the OPFS-backed File on success, or null on any error.
 */
export async function copyFileToOPFS(
  file: File,
  onProgress?: (pct: number) => void
): Promise<File | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR_NAME, { create: true });

    // Use a sanitized filename with timestamp to avoid collisions
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const opfsName = `${Date.now()}_${safeName}`;
    const handle = await dir.getFileHandle(opfsName, { create: true });

    const writable = await handle.createWritable();
    const totalSize = file.size;
    let written = 0;

    // Stream the file in chunks.
    // Yield to the macro-task queue every 10 chunks (every ~10 MB) so that
    // VLC's end-of-stream events and audio drain dispatches are not starved
    // by the microtask-only await chain.
    let chunkCount = 0;
    while (written < totalSize) {
      if (chunkCount > 0 && chunkCount % 10 === 0) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      const end = Math.min(written + CHUNK_SIZE, totalSize);
      const chunk = file.slice(written, end);
      const buffer = await chunk.arrayBuffer();
      await writable.write(buffer);
      written = end;
      chunkCount++;
      if (onProgress) {
        onProgress(Math.round((written / totalSize) * 100));
      }
    }

    await writable.close();

    // Store the mapping in localStorage for cross-session cache detection
    localStorage.setItem(cacheKey(file), opfsName);

    // Return the OPFS-backed File
    return await handle.getFile();
  } catch {
    // Quota exceeded, permission denied, or any other error — caller falls back
    return null;
  }
}

/**
 * Yield to the macro-task queue (setTimeout 0) once, allowing the browser
 * event loop to process pending tasks (e.g. VLC end-of-stream dispatches)
 * before a long async operation resumes.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, 0));
}
