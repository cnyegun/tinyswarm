import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import {
  type RunState,
  emit,
  latestIteration,
  log,
} from "./core.js";
import { listen, sendStaticFile } from "./static-server.js";

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
    if (!sendStaticFile(root, file, res)) {
      res.writeHead(404).end("Not found");
      return;
    }
  });
  const port = await listen(server, preferredPort).catch(
    (e: NodeJS.ErrnoException) =>
      e.code === "EADDRINUSE" ? listen(server, 0) : Promise.reject(e),
  );
  log(run, "serve", "listening", { port });
  emit(run, { type: "serve", port, localUrl: `http://localhost:${port}` });
  return { server, port };
}
