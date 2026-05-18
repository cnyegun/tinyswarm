import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
let app, source, harness, writes = 0;

const start = handler => new Promise(resolve => {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1", () => resolve(server));
});
const close = server => server && new Promise(resolve => server.close(resolve));
const port = server => server.address().port;
const body = req => new Promise(resolve => {
  let text = "";
  req.on("data", d => { text += d; });
  req.on("end", () => resolve(text ? JSON.parse(text) : {}));
});

try {
  source = await start((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="en"><head><title>Mock Event</title></head><body><nav><a href="/tickets">Learn more</a></nav><h1>Mock Event</h1><p>Join a practical accessibility event for builders and designers.</p><button>Register</button><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt=""></body></html>`);
  });

  harness = await start(async (req, res) => {
    if (req.method === "GET" && req.url === "/global/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ healthy: true, version: "mock" }));
      return;
    }
    if (req.method === "POST" && req.url.startsWith("/session?")) {
      await body(req);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "mock-session" }));
      return;
    }
    if (req.method === "POST" && req.url.startsWith("/session/mock-session/message?")) {
      const request = await body(req);
      const task = request.parts?.[0]?.text || "";
      const out = task.split("Output file: ")[1]?.split("\n")[0]?.trim();
      const path = join(root, out.replace("tiny-rewrite/", ""));
      writes++;
      const html = writes === 1
        ? `<!doctype html><html lang="en"><head><title>Mock Rewrite</title></head><body><h1>Mock Event</h1><p>Initial draft intentionally misses main.</p></body></html>`
        : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mock Rewrite</title><style>body{margin:0;font:18px/1.6 Arial,sans-serif;color:#111;background:#fff}a:focus{outline:3px solid #111}main{max-width:70ch;margin:auto;padding:2rem}</style></head><body><header><nav aria-label="Primary"><a href="#main">Skip to content</a></nav></header><main id="main"><h1>Mock Event</h1><p>Accessible repaired page.</p><a href="/tickets">Get tickets for Mock Event</a></main><footer><p>Mock footer</p></footer></body></html>`;
      writeFileSync(path, html);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ info: { id: `message-${writes}` }, parts: [{ type: "text", text: `wrote ${out}` }] }));
      return;
    }
    res.writeHead(404).end("not found");
  });

  app = spawn(process.execPath, ["dist/index.js", `http://127.0.0.1:${port(source)}/`], {
    cwd: root,
    env: { ...process.env, TINY_OPENCODE_SERVER_URL: `http://127.0.0.1:${port(harness)}` },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "", stderr = "";
  app.stderr.on("data", d => { stderr += d; });
  const local = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for Local URL\n${stdout}\n${stderr}`)), 30000);
    app.stdout.on("data", d => {
      stdout += d;
      const match = stdout.match(/Local: (http:\/\/localhost:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    app.once("exit", code => reject(new Error(`app exited ${code}\n${stdout}\n${stderr}`)));
  });
  const html = await fetch(local).then(r => r.text());
  const verification = await fetch(`${local}/verification.md`).then(r => r.text());
  const harnessLog = await fetch(`${local}/harness.log`).then(r => r.text());
  const transformedPath = stdout.match(/Transformed: (tiny-rewrite\/\S+)/)?.[1];
  const transformedFile = transformedPath && readFileSync(join(root, transformedPath.replace("tiny-rewrite/", "")), "utf8");
  if (!transformedFile?.includes("Accessible repaired page")) throw new Error("transformed.html did not contain repaired output");
  if (!html.includes("Accessible repaired page")) throw new Error("local server did not serve transformed output");
  if (!verification.includes("No verification failures")) throw new Error(`verification did not pass\n${verification}`);
  if (!harnessLog.includes("# initial") || !harnessLog.includes("# repair")) throw new Error("harness did not run initial and repair phases");
  console.log(`mock SDK harness test passed: ${local}`);
} finally {
  if (app) { app.kill("SIGTERM"); await Promise.race([once(app, "exit"), new Promise(r => setTimeout(r, 1000))]); }
  await close(source);
  await close(harness);
}
