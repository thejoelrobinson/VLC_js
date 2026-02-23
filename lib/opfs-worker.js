// lib/opfs-worker.js — OPFS copy worker
// Uses FileSystemSyncAccessHandle for synchronous writes (Worker-only API).
// Runs on a dedicated thread: zero interference with main thread ASYNCIFY at EOS.
// The EOS freeze bug was caused by main-thread Promise chains from createWritable()
// interleaving with ASYNCIFY's stack unwind. Moving to a Worker eliminates this.

const OPFS_DIR = 'vlcjs-cache';
const CHUNK = 4 * 1024 * 1024; // 4 MB read chunks

self.onmessage = async function (e) {
  const { type, file, opfsName } = e.data;
  if (type !== 'copy') return;

  try {
    const root = await navigator.storage.getDirectory();
    const dir  = await root.getDirectoryHandle(OPFS_DIR, { create: true });
    const fh   = await dir.getFileHandle(opfsName, { create: true });

    // createSyncAccessHandle() is only available in dedicated Workers — not main thread.
    // Synchronous writes avoid all Promise/microtask overhead during the copy.
    const sync = await fh.createSyncAccessHandle();

    let offset = 0;
    const total = file.size;
    while (offset < total) {
      const end = Math.min(offset + CHUNK, total);
      const buf = await file.slice(offset, end).arrayBuffer(); // async read from source
      sync.write(buf, { at: offset });                         // synchronous write to OPFS
      offset = end;
      self.postMessage({
        type: 'progress',
        pct: Math.round(offset / total * 100),
        offset,
        total,
      });
    }
    sync.flush();
    sync.close();
    self.postMessage({ type: 'done', opfsName });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err) });
  }
};
