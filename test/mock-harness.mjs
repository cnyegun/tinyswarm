import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const root = process.cwd();
let app, source, opencode;
let sessionCount = 0;
const sessions = new Map();
const prompts = [];

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
    if (req.url === "/assets/mock.css") {
      res.setHeader("content-type", "text/css; charset=utf-8");
      res.end("body{font-family:Arial,sans-serif} img{max-width:100%}");
      return;
    }
    if (req.url === "/assets/mock.js") {
      res.setHeader("content-type", "text/javascript; charset=utf-8");
      res.end("document.documentElement.dataset.mock='loaded';");
      return;
    }
    if (req.url === "/assets/logo.svg") {
      res.setHeader("content-type", "image/svg+xml");
      res.end("<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'><title>Mock logo</title><rect width='24' height='24' fill='black'/></svg>");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="en"><head><title>Mock Event</title><link rel="stylesheet" href="/assets/mock.css"><script type="module" src="/assets/mock.js"></script></head><body><header><nav><a href="/tickets">Learn more</a></nav></header><h1>Mock Event</h1><img src="/assets/logo.svg" alt="Mock logo"><p>Join a practical accessibility event for builders and designers.</p><button>Register</button></body></html>`);
  });

  opencode = await start(async (req, res) => {
    if (req.method === "GET" && req.url === "/global/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ healthy: true, version: "mock" }));
      return;
    }
    if (req.method === "POST" && req.url.startsWith("/session?")) {
      const request = await body(req);
      if (!request.permission?.some(rule => rule.permission === "*" && rule.pattern === "*" && rule.action === "allow")) {
        res.writeHead(400).end(JSON.stringify({ error: "missing allow-all" }));
        return;
      }
      const id = `mock-session-${++sessionCount}`;
      sessions.set(id, request.title || id);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id, title: request.title || id, time: { created: Date.now(), updated: Date.now() }, directory: root, projectID: "mock", version: "mock" }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/session/status?")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Object.fromEntries([...sessions.keys()].map(id => [id, { type: "idle" }]))));
      return;
    }
    if (req.method === "GET" && req.url.includes("/message")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([]));
      return;
    }
    const promptMatch = req.method === "POST" && req.url.match(/^\/session\/([^/]+)\/(?:message|prompt_async)\?/);
    if (promptMatch) {
      const request = await body(req);
      const text = request.parts?.[0]?.text || "";
      prompts.push({ sessionID: promptMatch[1], text });
      await writeMockOutput(text);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: `message-${prompts.length}`, sessionID: promptMatch[1], role: "assistant", parts: [], time: { created: Date.now() } }));
      return;
    }
    res.writeHead(404).end("not found");
  });

  app = spawn(process.execPath, ["dist/index.js", "accessibility", `http://127.0.0.1:${port(source)}/`], {
    cwd: root,
    env: { ...process.env, SWARM_OPENCODE_SERVER_URL: `http://127.0.0.1:${port(opencode)}`, SWARM_MAX_ITERATIONS: "2", SWARM_AGENT_TIMEOUT_MS: "10000" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "", stderr = "";
  app.stderr.on("data", d => { stderr += d; });
  const local = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for Local URL\n${stdout}\n${stderr}`)), 45000);
    app.stdout.on("data", d => {
      stdout += d;
      const match = stdout.match(/Local: (http:\/\/localhost:\d+)/) || stdout.match(/Local: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    app.once("exit", code => reject(new Error(`app exited ${code}\n${stdout}\n${stderr}`)));
  });

  const runPath = stdout.match(/Run: (runs\/\S+)/)?.[1];
  if (!runPath) throw new Error(`missing run path\n${stdout}`);
  const runDir = join(root, runPath);
  const sourceOrigin = `http://127.0.0.1:${port(source)}`;
  const original = readFileSync(join(runDir, "original.html"), "utf8");
  const transformed = readFileSync(join(runDir, "transformed.html"), "utf8");
  const decision = JSON.parse(readFileSync(join(runDir, "iterations", "002", "decision.json"), "utf8"));
  const checks = await fetch(`${local}/checks.json`).then(r => r.json());
  const report = await fetch(`${local}/report.html`).then(r => r.text());
  const brief = await fetch(`${local}/brief.md`).then(r => r.text());
  if (!transformed.includes("Accessible repaired page")) throw new Error("transformed.html did not contain final mock output");
  if (!original.includes(`${sourceOrigin}/assets/mock.css`)) throw new Error("original.html did not absolutize stylesheet URL");
  if (!original.includes(`${sourceOrigin}/assets/mock.js`)) throw new Error("original.html did not absolutize script URL");
  if (!original.includes(`${sourceOrigin}/assets/logo.svg`)) throw new Error("original.html did not absolutize image URL");
  if (!checks.passed) throw new Error(`latest checks did not pass: ${JSON.stringify(checks.failures)}`);
  if (decision.outcome !== "accept") throw new Error(`expected accept decision, got ${decision.outcome}`);
  if (!report.includes("Mock swarm report")) throw new Error("report.html was not served");
  if (!brief.includes("Mock accessibility brief")) throw new Error("brief.md was not served");
  if (sessionCount !== 6) throw new Error(`expected 6 reused sessions, got ${sessionCount}`);
  if (!prompts.some(p => p.text.includes("Output:") && p.text.includes("brief.md"))) throw new Error("brief prompt missing");
  if (prompts.filter(p => p.text.includes("Output:") && p.text.includes("findings/")).length !== 8) throw new Error("reviewer findings did not run every iteration");
  if (new Set(prompts.filter(p => p.text.includes("swarm orchestrator")).map(p => p.sessionID)).size !== 1) throw new Error("orchestrator session was not reused");
  if (!prompts.some(p => p.text.includes("Color/theme repair guardrail") && p.text.includes("bg-background opacity variants"))) throw new Error("aggregate prompt missing color guardrail");
  if (!prompts.some(p => p.text.includes("Color fixes must repair the whole computed color system") && p.text.includes("bg-background/85"))) throw new Error("fix prompt missing color guardrail");
  if (!existsSync(join(runDir, "prompts", "brief.md"))) throw new Error("brief prompt was not saved");
  if (!existsSync(join(runDir, "iterations", "001", "prompts", "fix.md"))) throw new Error("fix prompt was not saved");
  if (!existsSync(join(runDir, "prompts", "report.md"))) throw new Error("report prompt was not saved");
  console.log(`mock swarm test passed: ${local}`);
} finally {
  if (app) {
    app.kill("SIGTERM");
    await Promise.race([once(app, "exit"), new Promise(resolve => setTimeout(resolve, 1000))]);
  }
  await close(source);
  await close(opencode);
}

async function writeMockOutput(prompt) {
  const outputs = [...prompt.matchAll(/(?:Output|Outputs):[^\S\n]*([^\n]+)/g)].map(m => m[1].trim()).filter(p => p && !p.startsWith("- "));
  for (const line of prompt.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- /") || trimmed.startsWith("- ./")) outputs.push(trimmed.slice(2));
  }
  if (outputs.some(p => p.endsWith("report.md"))) {
    write(outputs.find(p => p.endsWith("report.md")), "# Mock swarm report\n\nAccepted.\n");
    write(outputs.find(p => p.endsWith("report.html")), "<!doctype html><html lang=\"en\"><head><title>Mock swarm report</title></head><body><main><h1>Mock swarm report</h1><a href=\"/\">Transformed</a></main></body></html>");
  }
  else if (outputs.some(p => p.endsWith("decision.json"))) write(outputs[0], decision(prompt));
  else if (outputs.some(p => p.includes("/votes/"))) write(outputs[0], vote(prompt));
  else if (outputs.some(p => p.endsWith("transformed.html"))) {
    write(outputs.find(p => p.endsWith("transformed.html")), html(prompt.includes("iteration 1")));
    write(outputs.find(p => p.endsWith("solver-result.json")), JSON.stringify({ changed: true, summary: "mock fix applied" }, null, 2));
  }
  else if (outputs.some(p => p.endsWith("aggregate-feedback.json"))) {
    write(outputs.find(p => p.endsWith("aggregate-feedback.json")), JSON.stringify({ summary: "mock feedback", priorities: ["fix landmarks"], risks: [] }, null, 2));
    write(outputs.find(p => p.endsWith("solver-task.md")), "# Solver task\n\nFix landmarks, title, and mobile layout.\n");
  }
  else if (outputs.some(p => p.includes("/findings/"))) write(outputs[0], finding(outputs[0]));
  else if (outputs.some(p => p.endsWith("brief.md"))) write(outputs.find(p => p.endsWith("brief.md")), "# Mock accessibility brief\n\nReview the page.\n");
}

function html(broken) {
  if (broken) return `<!doctype html><html lang="en"><head><title>Mock Rewrite</title></head><body><h1>Mock Event</h1><p>Initial draft intentionally misses main.</p></body></html>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mock Rewrite</title><style>body{margin:0;font:18px/1.6 Arial,sans-serif;color:#111;background:#fff}a:focus,button:focus{outline:3px solid #111;outline-offset:3px}main{max-width:70ch;margin:auto;padding:2rem}a{color:#0645ad}</style></head><body><header><nav aria-label="Primary"><a href="#main">Skip to content</a></nav></header><main id="main"><h1>Mock Event</h1><p>Accessible repaired page for builders and designers.</p><a href="/tickets">Get tickets for Mock Event</a></main><footer><p>Mock footer</p></footer></body></html>`;
}

function vote(prompt) {
  const checksPath = prompt.match(/Read transformed\.html, ([^,]+checks\.json)/)?.[1];
  const checks = checksPath && existsSync(checksPath) ? JSON.parse(readFileSync(checksPath, "utf8")) : { passed: false };
  return JSON.stringify({ vote: checks.passed ? "accept" : "revise", score: checks.passed ? 95 : 40, reason: checks.passed ? "passes mock checks" : "needs repair" }, null, 2);
}

function finding(path) {
  const role = path.match(/findings\/([^/]+)\.json$/)?.[1] || "reviewer";
  return JSON.stringify({ role, findings: [`${role} mock finding`], risk: "medium" }, null, 2);
}

function decision(prompt) {
  const iterDir = prompt.match(/Read ([^\n]+)checks\.json/)?.[1];
  const checksPath = iterDir && `${iterDir}checks.json`;
  const checks = checksPath && existsSync(checksPath) ? JSON.parse(readFileSync(checksPath, "utf8")) : { passed: false };
  const accepts = checks.passed ? 4 : 0;
  return JSON.stringify({ outcome: checks.passed ? "accept" : "continue", reason: checks.passed ? "passes mock checks" : "needs another iteration", checksPass: checks.passed, accepts, blocks: 0 }, null, 2);
}

function write(path, content) {
  if (!path) throw new Error("mock prompt did not include output path");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
