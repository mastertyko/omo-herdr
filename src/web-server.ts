import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebSnapshot } from "./web-model.ts";

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};
export interface WebServer {
  url: string;
  close: () => Promise<void>;
}
/** Static bundle + read-only snapshot API, restricted to this session and loopback. */
export async function startWebServer(
  snapshot: () => WebSnapshot,
  options: { assets?: string; port?: number } = {},
): Promise<WebServer> {
  const root =
    options.assets ??
    fileURLToPath(new URL("../web/dist/client/", import.meta.url));
  const assets = new Map<string, { body: Buffer; type: string }>();
  async function collect(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await collect(join(dir, entry.name), path);
      else if (entry.isFile() && types[extname(entry.name)])
        assets.set(path, {
          body: await readFile(join(dir, entry.name)),
          type: types[extname(entry.name)]!,
        });
    }
  }
  try {
    await collect(root, "");
  } catch {
    throw new Error(
      "Web assets are missing. Run npm run build:web or reinstall the published package.",
    );
  }
  if (!assets.has("/index.html"))
    throw new Error("Web bundle has no index.html.");
  const token = randomBytes(32).toString("hex");
  let origin = "";
  const server: Server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    if (
      req.headers.host !== origin.slice(7) ||
      (req.headers.origin && req.headers.origin !== origin) ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET" }).end();
      return;
    }
    let path: string;
    try {
      path = new URL(req.url ?? "/", origin).pathname;
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (path === "/api/snapshot") {
      const supplied = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        res.writeHead(401).end();
        return;
      }
      let body: string;
      try {
        body = JSON.stringify(snapshot());
      } catch {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(body);
      return;
    }
    const asset = assets.get(path === "/" ? "/index.html" : path);
    if (!asset) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": asset.type }).end(asset.body);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", () => {}); // A socket error must not terminate the agent host.
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not bind web viewer.");
  origin = `http://127.0.0.1:${address.port}`;
  server.unref();
  let closing: Promise<void> | undefined;
  return {
    url: `${origin}/#${token}`,
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      })),
  };
}
