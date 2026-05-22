import { existsSync, readFileSync, statSync } from "node:fs";
import { type Server, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".eot": "application/vnd.ms-fontobject",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function sendStaticFile(
  root: string,
  file: string,
  res: ServerResponse,
) {
  const safe = safeFile(root, file);
  if (!safe) return false;
  res.setHeader("Content-Type", contentType(safe));
  res.end(readFileSync(safe));
  return true;
}

export function listen(server: Server, port: number) {
  return new Promise<number>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen((server.address() as { port: number }).port);
    });
  });
}

function safeFile(root: string, file: string) {
  const resolvedRoot = resolve(root);
  const resolvedFile = resolve(file);
  if (!(resolvedFile === resolvedRoot || resolvedFile.startsWith(`${resolvedRoot}/`)))
    return undefined;
  return existsSync(resolvedFile) && statSync(resolvedFile).isFile()
    ? resolvedFile
    : undefined;
}

function contentType(file: string) {
  return MIME_TYPES[extname(file).toLowerCase()] || "application/octet-stream";
}
