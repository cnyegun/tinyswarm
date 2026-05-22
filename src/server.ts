import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, resolve } from "node:path";
import {
  type RunState,
  emit,
  latestIteration,
  log,
} from "./core.js";

/**
 * Starts a local HTTP server that serves run artifacts from `runDir`.
 *
 * Provides semantic routes so consumers can always use stable URLs regardless of
 * the profile's artifact name:
 * - `/` → the artifact (if it exists) or `report.html`
 * - `/report.html`, `/report.md`, `/brief.md` → direct file routes
 * - `/checks.json` → the checks from the most recent iteration
 *
 * Any other path is resolved relative to `runDir` after a path-traversal guard.
 * Tries port 5177 first; falls back to an OS-assigned port if that port is taken.
 */
export async function serve(run: RunState, artifact: string, preferredPort = 5177) {
  const { runDir } = run;
  const root = resolve(runDir);
  const server = createServer((req, res) => {
    const path = decodeURIComponent(
      new URL(req.url || "/", "http://local").pathname,
    );
    const latest = latestIteration(runDir);
    const routes: Record<string, string> = {
      "/": existsSync(join(runDir, artifact)) ? artifact : "report.html",
      "/report.html": "report.html",
      "/report.md": "report.md",
      "/brief.md": "brief.md",
      "/checks.json": latest
        ? join("iterations", latest, "checks.json")
        : "checks.json",
    };
    const routed = routes[path];
    const file = routed ? join(runDir, routed) : resolve(root, `.${path}`);
    // Reject requests that escape the run directory or point to non-files.
    if (
      !(file === root || file.startsWith(`${root}/`)) ||
      !existsSync(file) ||
      !statSync(file).isFile()
    ) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.setHeader("Content-Type", contentType(file));
    res.end(readFileSync(file));
  });
  const port = await listen(server, preferredPort).catch(
    (e: NodeJS.ErrnoException) =>
      e.code === "EADDRINUSE" ? listen(server, 0) : Promise.reject(e),
  );
  log(run, "serve", "listening", { port });
  emit(run, { type: "serve", port, localUrl: `http://localhost:${port}` });
  return { server, port };
}

function listen(server: Server, port: number) {
  return new Promise<number>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen((server.address() as { port: number }).port);
    });
  });
}

function contentType(file: string) {
  return (
    (
      {
        ".html": "text/html; charset=utf-8",
        ".md": "text/markdown; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
      } as Record<string, string>
    )[extname(file).toLowerCase()] || "application/octet-stream"
  );
}
