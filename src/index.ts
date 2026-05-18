#!/usr/bin/env node
import { AxeBuilder } from "@axe-core/playwright";
import { createOpencode, createOpencodeClient, type OpencodeClient, type Part } from "@opencode-ai/sdk/v2";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";

type Facts = {
  title: string; url: string; lang: string;
  headings: { level: number; text: string }[];
  links: { text: string; href: string }[]; buttons: { text: string }[];
  images: { alt: string; src: string }[];
  landmarks: { tag: string; role: string; label: string }[];
  paragraphs: string[]; textSnippets: string[];
};
type Violation = { id: string; impact: string; help: string; nodes: { target: string; html: string }[] };
type Harness = { client: OpencodeClient; url: string; close?: () => void };

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const csp = "default-src 'none'; img-src data: http: https:; style-src 'unsafe-inline'; font-src data: http: https:; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const mood: Record<string, string> = {
  "browser.launch": "browser goblin is polishing the goggles",
  "browser.goto": "browser goblin is visiting the original page",
  "browser.extract": "fact ferret is collecting headings, links, and text",
  "axe.run": "axe sprite is tapping the page",
  "brief.build": "brief bard is writing accessibility quest notes",
  "task.build": "task kettle is brewing an agent assignment",
  "harness.run": "agent harness is doing the rewrite",
  "verify.run": "browser judge is checking the generated page",
  "artifact.write": "artifact squirrel is stashing files",
  "server.listen": "tiny innkeeper is opening the local door",
  fatal: "tiny gremlin tripped"
};
let logFile = "";
let started = Date.now();
let harness: Harness | undefined;
let harnessSessionID = "";

function log(scope: string, message: string, data?: unknown, level = "INFO") {
  const line = `${new Date().toISOString()} +${Date.now() - started}ms ${level} ${scope} ${message}${data ? ` ${JSON.stringify(data)}` : ""}\n`;
  if (logFile) appendFileSync(logFile, line);
  const note = `[tiny] ${mood[scope] || scope}: ${message}${data ? ` ${JSON.stringify(data)}` : ""}`;
  (level === "ERROR" ? console.error : console.log)(note);
}
const shown = (path: string) => `tiny-rewrite/${relative(rootDir, path)}`;
const clip = (text = "", n = 500) => squash(text).slice(0, n);
const harnessAgent = () => process.env.TINY_HARNESS_AGENT || "build";
const harnessModel = () => {
  const spec = process.env.TINY_HARNESS_MODEL || "deepseek/deepseek-v4-flash";
  const [providerID, ...modelParts] = spec.split("/");
  return { providerID, modelID: modelParts.join("/"), variant: process.env.TINY_HARNESS_VARIANT || "max" };
};

async function main() {
  const url = process.argv[2];
  if (!url) throw new Error("Usage: npm run tiny -- <url>");
  const runDir = join(rootDir, "runs", new Date().toISOString().split(".").join("-").split(":").join("-"));
  mkdirSync(runDir, { recursive: true });
  logFile = join(runDir, "scan.log");
  started = Date.now();

  const { originalHtml, facts, violations } = await loadOriginal(url);
  const auditBrief = buildAuditBrief(facts, violations);
  log("brief.build", "built audit brief", { bytes: auditBrief.length });

  writeFileSync(join(runDir, "original.html"), originalHtml);
  writeFileSync(join(runDir, "facts.json"), JSON.stringify(facts, null, 2));
  writeFileSync(join(runDir, "audit-brief.md"), auditBrief);
  log("artifact.write", "wrote scan artifacts", { runDir: shown(runDir) });

  const task = buildHarnessTask(runDir, facts, false, []);
  writeFileSync(join(runDir, "task.md"), task);
  log("task.build", "built harness task", { chars: task.length });
  await runHarness(join(runDir, "task.md"), runDir, "initial");

  let failures = await verifyTransformed(runDir, facts, "initial");
  if (failures.length) {
    const repairTask = buildHarnessTask(runDir, facts, true, failures);
    writeFileSync(join(runDir, "repair-task.md"), repairTask);
    log("task.build", "built one repair task", { chars: repairTask.length, failures: failures.length });
    await runHarness(join(runDir, "repair-task.md"), runDir, "repair");
    failures = await verifyTransformed(runDir, facts, "final");
  }
  closeHarness();
  writeFileSync(join(runDir, "verification.md"), failures.length ? failures.map(f => `- ${f}`).join("\n") + "\n" : "No verification failures found.\n");
  log("verify.run", failures.length ? "serving after one repair with remaining failures" : "verification passed", { failures: failures.length }, failures.length ? "WARN" : "INFO");

  const port = await serve(runDir);
  console.log(`Run: ${shown(runDir)}`);
  console.log(`Original: ${shown(join(runDir, "original.html"))}`);
  console.log(`Facts: ${shown(join(runDir, "facts.json"))}`);
  console.log(`Audit brief: ${shown(join(runDir, "audit-brief.md"))}`);
  console.log(`Task: ${shown(join(runDir, "task.md"))}`);
  console.log(`Transformed: ${shown(join(runDir, "transformed.html"))}`);
  console.log(`Verification: ${shown(join(runDir, "verification.md"))}`);
  console.log(`Harness log: ${shown(join(runDir, "harness.log"))}`);
  console.log(`Log: ${shown(join(runDir, "scan.log"))}`);
  console.log(`Local: http://localhost:${port}`);
}

async function loadOriginal(url: string) {
  log("browser.launch", "launching chromium");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
    const page = await context.newPage();
    log("browser.goto", "opening page", { url });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
    const facts = await extractFacts(page);
    log("browser.extract", "extracted rendered facts", { headings: facts.headings.length, links: facts.links.length });
    const violations = await runAxe(page, "original");
    return { originalHtml: await page.content(), facts, violations };
  } finally {
    await browser.close();
  }
}

async function extractFacts(page: Page): Promise<Facts> {
  return page.evaluate(() => {
    const clean = (s?: string | null) => {
      let out = "", lastSpace = true;
      for (const ch of s || "") {
        const space = ch <= " ";
        if (space) { if (!lastSpace) out += " "; lastSpace = true; }
        else { out += ch; lastSpace = false; }
      }
      return out.trim();
    };
    const visible = (e: Element) => {
      const h = e as HTMLElement, r = h.getBoundingClientRect(), s = getComputedStyle(h);
      return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
    };
    const els = (sel: string, n: number) => Array.from(document.querySelectorAll(sel)).filter(visible).slice(0, n);
    const txt = (e: Element) => clean((e as HTMLElement).innerText || e.textContent);
    const uniq = (xs: string[], n: number) => Array.from(new Set(xs.filter(Boolean))).slice(0, n);
    return {
      title: clean(document.title), url: location.href, lang: document.documentElement.lang || "",
      headings: els("h1,h2,h3,h4,h5,h6", 50).map(e => ({ level: Number(e.tagName[1]), text: txt(e) })),
      links: els("a[href]", 80).map(e => ({ text: txt(e) || clean(e.getAttribute("aria-label")) || clean(e.getAttribute("title")), href: (e as HTMLAnchorElement).href })).filter(x => x.text || x.href),
      buttons: els("button,[role=button],input[type=button],input[type=submit]", 40).map(e => ({ text: txt(e) || clean(e.getAttribute("aria-label")) || clean((e as HTMLInputElement).value) })),
      images: els("img", 50).map(e => ({ alt: clean((e as HTMLImageElement).alt), src: (e as HTMLImageElement).currentSrc || (e as HTMLImageElement).src })),
      landmarks: els("header,nav,main,aside,footer,[role]", 40).map(e => ({ tag: e.tagName.toLowerCase(), role: e.getAttribute("role") || "", label: clean(e.getAttribute("aria-label")) || txt(e).slice(0, 100) })),
      paragraphs: els("p,li", 100).map(txt).filter(t => t.length > 20).slice(0, 80),
      textSnippets: uniq((document.body?.innerText || "").split("\n").map(clean).filter(t => t.length > 30), 80)
    };
  });
}

async function runAxe(page: Page, target: string): Promise<Violation[]> {
  log("axe.run", `running axe on ${target}`);
  const result = await new AxeBuilder({ page }).analyze();
  const violations = result.violations.slice(0, 20).map(v => ({
    id: v.id, impact: v.impact || "unknown", help: v.help,
    nodes: v.nodes.slice(0, 3).map(n => ({ target: n.target.join(", "), html: clip(n.html, 300) }))
  }));
  log("axe.run", "axe finished", { target, violations: violations.length });
  return violations;
}

function buildAuditBrief(facts: Facts, violations: Violation[]) {
  const ids = new Set(violations.map(v => v.id));
  const h1 = facts.headings.find(h => h.level === 1)?.text || facts.headings[0]?.text || facts.title || "Untitled page";
  const sections = facts.headings.filter(h => h.level <= 2).map(h => h.text).slice(0, 10);
  const ctas = [...facts.buttons.map(b => b.text), ...facts.links.map(l => l.text)].filter(Boolean).slice(0, 10);
  const links = facts.links.filter(l => l.text && l.href).slice(0, 12).map(l => `${l.text} (${l.href})`);
  const hasMain = facts.landmarks.some(l => l.tag === "main" || l.role === "main");
  const weak = new Set(["click here", "read more", "learn more", "more"]);
  const weakLinks = facts.links.some(l => weak.has(l.text.toLowerCase()));
  const problems = [
    !hasMain || ids.has("landmark-one-main") || ids.has("region") ? "Missing or weak landmarks: rebuild as header/nav/main/footer with labelled sections." : "Landmarks: keep semantic regions explicit and labelled.",
    ids.has("heading-order") ? "Heading order issues: use exactly one h1 and ordered h2/h3 sections." : "Heading structure: preserve one clear h1 and predictable section headings.",
    ids.has("color-contrast") ? "Contrast issues: use high-contrast foreground/background pairs." : "Contrast: use strong contrast even where axe did not flag it.",
    "Small text: keep body copy at least 16px with comfortable spacing.",
    "Reflow: make sections fluid for mobile and 200% zoom.",
    "Focus visibility risk: provide obvious focus states for every link and control.",
    weakLinks ? "Ambiguous link names: replace vague repeated labels with descriptive text." : "Link names: keep CTAs descriptive and unique."
  ];
  const axe = violations.length ? violations.slice(0, 8).map(v => `- ${v.id} (${v.impact}): ${v.help}; targets: ${v.nodes.map(n => n.target).join(" | ")}`).join("\n") : "- No axe violations returned, but still redesign defensively.";
  return `# Accessibility Audit Brief\n\n## Page Identity\n- Title: ${facts.title || h1}\n- URL: ${facts.url}\n- Main purpose: ${clip([h1, ...facts.textSnippets].join(" "), 220)}\n\n## Preserve\n- Brand/name: ${h1}\n- Primary CTAs: ${ctas.join("; ") || "None clearly extracted"}\n- Important links: ${links.join("; ") || "None clearly extracted"}\n- Core content sections: ${sections.join("; ") || "Use extracted body content"}\n\n## Problems Found\n${problems.map(p => `- ${p}`).join("\n")}\n\n## Axe Summary\n${axe}\n\n## Redesign Direction\n- Full accessible landing page redesign\n- High contrast\n- Clear responsive sections\n- Semantic header/nav/main/footer\n- Cards/lists for repeated content\n- Big readable type\n- Strong focus states\n- No motion dependency\n`;
}

function buildHarnessTask(runDir: string, facts: Facts, repair: boolean, failures: string[]) {
  const run = shown(runDir);
  const images = uniqueImages(facts).map((img, i) => `- ${i + 1}. ${img.alt}: ${describeSrc(img.src)}`).join("\n") || "- No meaningful images extracted.";
  return `# Xcessible Agent Harness Task\n\nYou are the rewrite agent for a local accessibility demo. Use your tools to inspect the inputs and write the final artifact.\n\nWorking directory: ${rootDir}\nRun directory: ${run}\nOutput file: ${run}/transformed.html\n\nInputs:\n- DESIGN.skill\n- ${run}/original.html\n- ${run}/facts.json\n- ${run}/audit-brief.md\n\nGoal:\nCreate one complete self-contained HTML document in ${run}/transformed.html. Preserve the original brand, purpose, important content, CTAs, real links, brand imagery, and partner imagery. Redesign the page freely for accessibility, readability, and responsive behavior.\n\nImplementation notes:\n- Use semantic header/nav/main/section/footer structure with one h1.\n- Include internal CSS. Do not rely on external CSS or JavaScript.\n- Avoid scripts, iframes, object/embed content, inline event handlers, and form actions.\n- Preserve every meaningful unique image from facts.json, especially brand and partner logos.\n- Copy image src values exactly from facts.json. Do not retype, shorten, regenerate, or alter data: URIs.\n- Use useful alt text, or empty alt only when nearby text already names the same brand.\n- Self-evaluate the written file before finishing. Check mobile layout, headings, landmarks, link names, focus states, and obvious axe issues.\n- Self-evaluate that every img loads with non-zero naturalWidth and naturalHeight.\n- Do not modify source code or the input artifacts. Only write transformed.html.\n\nMeaningful unique images to preserve:\n${images}\n${repair ? `\nVerification failed after the first write. This is the only repair iteration for this run. Revise transformed.html to address these failures, then stop:\n${failures.map(f => `- ${f}`).join("\n")}\n` : ""}`;
}

async function runHarness(taskFile: string, runDir: string, phase: string) {
  const harnessLog = join(runDir, "harness.log");
  const task = readFileSync(taskFile, "utf8");
  const active = await ensureHarness(harnessLog);
  const session = await ensureHarnessSession(active, runDir, harnessLog);
  const model = harnessModel();
  log("harness.run", `starting ${phase}`, { server: active.url, session, task: shown(taskFile), model: `${model.providerID}/${model.modelID}`, variant: model.variant });
  appendFileSync(harnessLog, `\n# ${phase}\nSDK session.prompt ${active.url}\n`);
  const result = await active.client.session.prompt({
    sessionID: session,
    directory: rootDir,
    agent: harnessAgent(),
    model: { providerID: model.providerID, modelID: model.modelID },
    variant: model.variant,
    parts: [{ type: "text", text: task }]
  });
  if (result.error) throw new Error(`opencode SDK prompt failed: ${JSON.stringify(result.error)}`);
  const lines = (result.data.parts as Part[]).map(p => p.type === "text" ? `text: ${clip(p.text, 600)}` : p.type);
  appendFileSync(harnessLog, lines.length ? `${lines.join("\n")}\n` : "No response parts returned.\n");
  if (!existsSync(join(runDir, "transformed.html"))) throw new Error("Agent harness did not create transformed.html");
  log("harness.run", `finished ${phase}`);
}

async function ensureHarness(outFile: string): Promise<Harness> {
  if (harness) return harness;
  if (process.env.TINY_OPENCODE_SERVER_URL) {
    harness = { url: process.env.TINY_OPENCODE_SERVER_URL, client: createOpencodeClient({ baseUrl: process.env.TINY_OPENCODE_SERVER_URL }) };
    appendFileSync(outFile, `SDK client: ${harness.url}\n`);
    return harness;
  }
  const started = await createOpencode({ hostname: "127.0.0.1", port: 0, timeout: Number(process.env.TINY_HARNESS_START_TIMEOUT_MS || 30000) });
  harness = { client: started.client, url: started.server.url, close: started.server.close };
  appendFileSync(outFile, `SDK server: ${harness.url}\n`);
  return harness;
}

async function ensureHarnessSession(active: Harness, runDir: string, outFile: string) {
  if (harnessSessionID) return harnessSessionID;
  const model = harnessModel();
  const result = await active.client.session.create({
    directory: rootDir,
    title: `tiny rewrite ${relative(rootDir, runDir)}`,
    agent: harnessAgent(),
    model: { providerID: model.providerID, id: model.modelID, variant: model.variant }
  });
  if (result.error) throw new Error(`opencode SDK session create failed: ${JSON.stringify(result.error)}`);
  harnessSessionID = result.data.id;
  appendFileSync(outFile, `Session: ${harnessSessionID}\n`);
  return harnessSessionID;
}

function closeHarness() {
  harness?.close?.();
  harness = undefined;
  harnessSessionID = "";
}

async function verifyTransformed(runDir: string, facts: Facts, phase: string) {
  const htmlPath = join(runDir, "transformed.html");
  const failures: string[] = [];
  if (!existsSync(htmlPath)) return ["transformed.html was not created"];
  log("verify.run", `checking transformed page (${phase})`);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
    const page = await context.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "domcontentloaded" });
    const dom = await page.evaluate(() => ({
      title: document.title.trim(),
      h1: document.querySelectorAll("h1").length,
      main: !!document.querySelector("main"),
      badElements: document.querySelectorAll("script,iframe,object,embed").length,
      eventHandlers: Array.from(document.querySelectorAll("*")).filter(e => e.getAttributeNames().some(n => n.startsWith("on"))).length
    }));
    if (!dom.title) failures.push("missing document title");
    if (dom.h1 !== 1) failures.push(`expected exactly one h1, found ${dom.h1}`);
    if (!dom.main) failures.push("missing main landmark");
    if (dom.badElements) failures.push(`contains blocked active/embed elements: ${dom.badElements}`);
    if (dom.eventHandlers) failures.push(`contains inline event handler attributes: ${dom.eventHandlers}`);
    const imageState = await page.evaluate(() => Array.from(document.images).map((img, i) => ({
      index: i + 1,
      alt: img.alt,
      src: img.getAttribute("src") || "",
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight
    })));
    for (const img of imageState) {
      if (!img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) failures.push(`image ${img.index} failed to load: alt=${JSON.stringify(img.alt)} src=${describeSrc(img.src)}`);
    }
    const usedSrcs = new Set(imageState.map(img => img.src));
    for (const img of uniqueImages(facts)) {
      if (!usedSrcs.has(img.src)) failures.push(`missing meaningful image from facts.json: alt=${JSON.stringify(img.alt)} src=${describeSrc(img.src)}`);
    }
    for (const v of (await runAxe(page, `transformed ${phase}`)).slice(0, 8)) failures.push(`axe ${v.id} (${v.impact}): ${v.help}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "domcontentloaded" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (overflow) failures.push("mobile viewport has horizontal overflow");
  } finally {
    await browser.close();
  }
  log("verify.run", `finished ${phase} verification`, { failures: failures.length }, failures.length ? "WARN" : "INFO");
  return failures;
}

async function serve(runDir: string) {
  const routes: Record<string, [string, string]> = {
    "/": ["transformed.html", "text/html; charset=utf-8"], "/original": ["original.html", "text/html; charset=utf-8"],
    "/facts.json": ["facts.json", "application/json; charset=utf-8"], "/audit-brief.md": ["audit-brief.md", "text/markdown; charset=utf-8"],
    "/task.md": ["task.md", "text/markdown; charset=utf-8"], "/repair-task.md": ["repair-task.md", "text/markdown; charset=utf-8"],
    "/verification.md": ["verification.md", "text/markdown; charset=utf-8"], "/harness.log": ["harness.log", "text/plain; charset=utf-8"],
    "/scan.log": ["scan.log", "text/plain; charset=utf-8"]
  };
  const server = createServer((req, res) => {
    const route = routes[new URL(req.url || "/", "http://local").pathname];
    if (!route) { res.writeHead(404).end("Not found"); return; }
    if (route[0] === "transformed.html") res.setHeader("Content-Security-Policy", csp);
    res.setHeader("Content-Type", route[1]);
    res.end(readFileSync(join(runDir, route[0])));
  });
  const port = await listen(server, 5177).catch((e: NodeJS.ErrnoException) => e.code === "EADDRINUSE" ? listen(server, 0) : Promise.reject(e));
  log("server.listen", "serving run", { port });
  return port;
}

function listen(server: Server, port: number) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => { server.off("error", reject); resolve((server.address() as { port: number }).port); });
  });
}

function squash(text = "") {
  let out = "", lastSpace = true;
  for (const ch of text) {
    const space = ch <= " ";
    if (space) { if (!lastSpace) out += " "; lastSpace = true; }
    else { out += ch; lastSpace = false; }
  }
  return out.trim();
}

function uniqueImages(facts: Facts) {
  const seen = new Set<string>();
  return facts.images.filter(img => img.alt.trim() && img.src && !seen.has(img.src) && seen.add(img.src));
}

function describeSrc(src: string) {
  return src.startsWith("data:") ? `${src.slice(0, 32)}... (${src.length} chars)` : src;
}

main().catch(e => { log("fatal", e instanceof Error ? e.message : String(e), undefined, "ERROR"); process.exit(1); });
