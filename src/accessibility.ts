import { AxeBuilder } from "@axe-core/playwright";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { chromium, type Page } from "playwright";
import type { CheckResult, Decision, SwarmProfile } from "./core.js";

type Facts = {
  title: string;
  url: string;
  lang: string;
  headings: { level: number; text: string }[];
  links: { text: string; href: string }[];
  buttons: { text: string }[];
  images: { alt: string; src: string }[];
  landmarks: { tag: string; role: string; label: string }[];
  textSnippets: string[];
};

const reviewers = [
  { id: "semantic", name: "screen-reader/semantic structure reviewer" },
  { id: "keyboard", name: "keyboard and motor access reviewer" },
  { id: "cognitive", name: "cognitive load and task clarity reviewer" },
  { id: "visual", name: "low-vision, contrast, zoom, mobile reviewer" }
];

export const accessibilityProfile: SwarmProfile = {
  id: "accessibility",
  artifact: "transformed.html",
  reviewers,
  scan,
  check,
  briefPrompt: ({ runDir }) => `You are the swarm orchestrator. Read these files and write a concise accessibility brief.\n\nRun directory: ${runDir}\nInputs:\n- ${join(runDir, "original.html")}\n- ${join(runDir, "facts.json")}\n- ${join(runDir, "axe.json")}\n\nOutput: ${join(runDir, "brief.md")}\n\nKeep it practical. Include page purpose, key content to preserve, major accessibility risks, and what reviewers should focus on. Write only files inside the run directory.`,
  findingsPrompt: ({ runDir, iterDir, iteration }, reviewer) => `You are the ${reviewer.name}. Review iteration ${iteration}.\n\nRun directory: ${runDir}\nRead original.html, facts.json, axe.json, brief.md, transformed.html if present, and prior iteration artifacts if useful.\nOutput: ${join(iterDir, "findings", `${reviewer.id}.json`)}\n\nWrite exactly this small JSON shape:\n{ "role": "${reviewer.id}", "findings": ["short actionable finding"], "risk": "low" | "medium" | "high" }\nDo not edit transformed.html.`,
  aggregatePrompt: ({ runDir, iterDir, iteration }) => `You are the swarm orchestrator. Aggregate reviewer findings for iteration ${iteration}.\n\nRun directory: ${runDir}\nRead brief.md, ${join(iterDir, "findings")}/*.json, and prior iterations if useful.\nOutputs:\n- ${join(iterDir, "aggregate-feedback.json")}\n- ${join(iterDir, "solver-task.md")}\n\naggregate-feedback.json shape:\n{ "summary": "string", "priorities": ["short task"], "risks": ["short risk"] }\nsolver-task.md should tell the fixer exactly what to change. Write only these files.`,
  fixPrompt: ({ runDir, iterDir, iteration }) => `You are the fixer. Apply solver-task.md for iteration ${iteration}.\n\nRun directory: ${runDir}\nRead original.html, facts.json, axe.json, brief.md, and ${join(iterDir, "solver-task.md")}.\nOutputs:\n- ${join(runDir, "transformed.html")}\n- ${join(iterDir, "solver-result.json")}\n\nRequirements: valid standalone HTML, title, exactly one h1, main landmark, no axe violations, no mobile horizontal overflow, visible focus styles, responsive layout. Preserve original meaning, important content, links, and useful images. solver-result.json shape: { "changed": true, "summary": "string" }.`,
  votePrompt: ({ runDir, iterDir }, reviewer) => `You are the ${reviewer.name}. Re-review transformed.html and vote.\n\nRun directory: ${runDir}\nRead transformed.html, ${join(iterDir, "solver-result.json")}, ${join(iterDir, "checks.json")}, brief.md, and ${join(iterDir, "solver-task.md")}.\nOutput: ${join(iterDir, "votes", `${reviewer.id}.json`)}\n\nWrite exactly this tiny JSON shape:\n{ "vote": "accept" | "revise" | "block", "score": number, "reason": "short reason" }`,
  decisionPrompt: ({ runDir, iterDir, iteration }) => `You are the swarm orchestrator. Decide whether iteration ${iteration} is done.\n\nRun directory: ${runDir}\nRead ${join(iterDir, "checks.json")} and ${join(iterDir, "votes")}/*.json.\nOutput: ${join(iterDir, "decision.json")}\n\nWrite exactly this JSON shape:\n{ "outcome": "accept" | "continue" | "stop_with_risks", "reason": "string", "checksPass": boolean, "accepts": number, "blocks": number }\nUse continue when important issues remain. Use accept when checks pass and reviewers mostly accept. Use stop_with_risks only when continuing is not useful.`,
  reportPrompt: ({ runDir }, decision?: Decision) => `You are the swarm orchestrator. Write the final report.\n\nRun directory: ${runDir}\nFinal decision: ${JSON.stringify(decision || null)}\nRead brief.md, iterations/*/aggregate-feedback.json, iterations/*/solver-result.json, iterations/*/checks.json, votes, and decision.json.\nOutputs:\n- ${join(runDir, "report.md")}\n- ${join(runDir, "report.html")}\n\nKeep report.md concise. report.html should be simple standalone HTML linking to transformed.html and artifacts. Write only these report files.`
};

async function scan(url: string, { runDir }: { runDir: string }) {
  mkdirSync(join(runDir, "screenshots"), { recursive: true });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
    const facts = await extractFacts(page);
    const axe = await new AxeBuilder({ page }).analyze();
    await page.screenshot({ path: join(runDir, "screenshots", "original.png"), fullPage: true });
    writeFileSync(join(runDir, "original.html"), await page.content());
    writeFileSync(join(runDir, "facts.json"), JSON.stringify(facts, null, 2));
    writeFileSync(join(runDir, "axe.json"), JSON.stringify(axe, null, 2));
  } finally {
    await browser.close();
  }
}

async function extractFacts(page: Page): Promise<Facts> {
  return page.evaluate(() => {
    const clean = (s?: string | null) => (s || "").replace(/\s+/g, " ").trim();
    const visible = (e: Element) => {
      const h = e as HTMLElement;
      const r = h.getBoundingClientRect();
      const s = getComputedStyle(h);
      return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
    };
    const els = (sel: string, n: number) => Array.from(document.querySelectorAll(sel)).filter(visible).slice(0, n);
    const text = (e: Element) => clean((e as HTMLElement).innerText || e.textContent);
    return {
      title: clean(document.title),
      url: location.href,
      lang: document.documentElement.lang || "",
      headings: els("h1,h2,h3,h4,h5,h6", 60).map(e => ({ level: Number(e.tagName[1]), text: text(e) })),
      links: els("a[href]", 100).map(e => ({ text: text(e) || clean(e.getAttribute("aria-label")) || clean(e.getAttribute("title")), href: (e as HTMLAnchorElement).href })),
      buttons: els("button,[role=button],input[type=button],input[type=submit]", 60).map(e => ({ text: text(e) || clean(e.getAttribute("aria-label")) || clean((e as HTMLInputElement).value) })),
      images: els("img", 80).map(e => ({ alt: clean((e as HTMLImageElement).alt), src: (e as HTMLImageElement).currentSrc || (e as HTMLImageElement).src })),
      landmarks: els("header,nav,main,aside,footer,[role]", 60).map(e => ({ tag: e.tagName.toLowerCase(), role: e.getAttribute("role") || "", label: clean(e.getAttribute("aria-label")) || text(e).slice(0, 120) })),
      textSnippets: Array.from(new Set((document.body?.innerText || "").split("\n").map(clean).filter(t => t.length > 30))).slice(0, 100)
    };
  });
}

async function check({ runDir }: { runDir: string }, iteration: number): Promise<CheckResult> {
  const failures: string[] = [];
  const htmlPath = join(runDir, "transformed.html");
  if (!existsSync(htmlPath)) failures.push("transformed.html missing");
  const preview = await serve(runDir, 0);
  const browser = await chromium.launch();
  let dom = { title: "", h1: 0, main: false };
  let axeViolations: unknown[] = [];
  let mobileOverflow = false;
  try {
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
    const page = await context.newPage();
    await page.goto(`http://localhost:${preview.port}/`, { waitUntil: "networkidle" });
    dom = await page.evaluate(() => ({ title: document.title.trim(), h1: document.querySelectorAll("h1").length, main: !!document.querySelector("main") }));
    if (!dom.title) failures.push("missing title");
    if (dom.h1 !== 1) failures.push(`expected one h1, found ${dom.h1}`);
    if (!dom.main) failures.push("missing main");
    const axe = await new AxeBuilder({ page }).analyze();
    axeViolations = axe.violations;
    for (const v of axe.violations) failures.push(`axe ${v.id}: ${v.help}`);
    await page.screenshot({ path: join(runDir, "screenshots", `transformed-${String(iteration).padStart(3, "0")}.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://localhost:${preview.port}/`, { waitUntil: "networkidle" });
    mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (mobileOverflow) failures.push("mobile horizontal overflow");
  } finally {
    await browser.close();
    preview.server.close();
  }
  return { passed: failures.length === 0, failures, title: dom.title, h1: dom.h1, main: dom.main, mobileOverflow, axeViolations };
}

async function serve(runDir: string, preferredPort: number) {
  const root = resolve(runDir);
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url || "/", "http://local").pathname);
    const file = path === "/" ? join(runDir, "transformed.html") : resolve(root, `.${path}`);
    if (!(file === root || file.startsWith(`${root}/`)) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(readFileSync(file));
  });
  const port = await listen(server, preferredPort);
  return { server, port };
}

function listen(server: Server, port: number) {
  return new Promise<number>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolveListen((server.address() as { port: number }).port); });
  });
}
