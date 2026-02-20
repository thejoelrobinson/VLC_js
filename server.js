const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PORT = 3000;
const ROOT = __dirname;

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const COMPRESSIBLE_EXTS = new Set([".html", ".js", ".css", ".svg", ".json"]);

const server = http.createServer((req, res) => {
  let filePath = path.join(ROOT, req.url === "/" ? "vlc.html" : req.url);
  const resolved = path.resolve(filePath);

  // Path traversal protection
  if (!resolved.startsWith(ROOT + path.sep) && resolved !== ROOT) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  // Required for SharedArrayBuffer (WASM threads)
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");

  fs.stat(resolved, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    // ETag based on file size and mtime
    const etag = `"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`;
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "public, max-age=300");

    // 304 Not Modified
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304);
      res.end();
      return;
    }

    const headers = { "Content-Type": contentType };
    const acceptEncoding = req.headers["accept-encoding"] || "";
    const shouldCompress = COMPRESSIBLE_EXTS.has(ext) && acceptEncoding.includes("gzip");

    if (shouldCompress) {
      headers["Content-Encoding"] = "gzip";
      res.writeHead(200, headers);
      fs.createReadStream(resolved).pipe(zlib.createGzip()).pipe(res);
    } else {
      res.writeHead(200, headers);
      fs.createReadStream(resolved).pipe(res);
    }
  });
});

server.listen(PORT, () => {
  console.log(`VLC.js dev server running at http://localhost:${PORT}`);
});
