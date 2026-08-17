import { createReadStream, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { extname, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const repository = resolve(import.meta.dirname, "..");
const webRoot = resolve(repository, "web");
const host = process.env.GOMOKU_WEB_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.GOMOKU_WEB_PORT || "4173", 10);
const roomHost = process.env.GOMOKU_HOST || "127.0.0.1";
const roomPort = Number.parseInt(process.env.GOMOKU_PORT || "8798", 10);
const origin = `http://${host}:${port}`;

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const rooms = spawn(process.execPath, [resolve(repository, "server/room-server.mjs")], {
  stdio: "inherit",
  env: {
    ...process.env,
    GOMOKU_HOST: roomHost,
    GOMOKU_PORT: String(roomPort),
    GOMOKU_ALLOWED_ORIGIN: process.env.GOMOKU_ALLOWED_ORIGIN || origin
  }
});

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", origin);
  if (url.pathname.startsWith("/api/gomoku")) {
    const proxy = httpRequest({
      hostname: roomHost,
      port: roomPort,
      path: `${url.pathname}${url.search}`,
      method: req.method,
      headers: { ...req.headers, host: `${roomHost}:${roomPort}` }
    }, (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    });
    proxy.on("error", () => {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { code: "UPSTREAM_UNAVAILABLE", message: "房间服务尚未就绪" } }));
    });
    req.pipe(proxy);
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(webRoot, relativePath);
  if (candidate !== webRoot && !candidate.startsWith(`${webRoot}${sep}`)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const file = statSync(candidate).isDirectory() ? resolve(candidate, "index.html") : candidate;
    const size = statSync(file).size;
    res.writeHead(200, {
      "Content-Type": contentTypes[extname(file)] || "application/octet-stream",
      "Content-Length": size,
      "Cache-Control": "no-cache"
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(`Gomoku web app listening on ${origin}`);
});

function shutdown(signal) {
  server.close();
  if (!rooms.killed) rooms.kill(signal);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
rooms.on("exit", (code) => {
  if (code && code !== 0) process.exitCode = code;
});
