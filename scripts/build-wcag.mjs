#!/usr/bin/env node
/**
 * Builds the agent-facing WCAG 2.2 reference from the W3C single-page spec.
 *
 * The full spec HTML is far too large to put in front of an agent. This script
 * parses it once into a small, navigable reference that the swarm agents query
 * with their normal Read/Grep tools:
 *
 *   reference/wcag/index.md          principle -> guideline -> SC tree (prompt-sized)
 *   reference/wcag/sc/<n>-<slug>.md  one file per success criterion (targeted reads)
 *   reference/wcag/glossary.md       every WCAG term and its definition
 *   reference/wcag/wcag-map.json     SC lookup + exact axe-tag -> SC index
 *
 * Source: WCAG_2.2.html in the repo root (the W3C single-page HTML). WCAG text
 * changes rarely, so the generated reference is committed and this script only
 * needs to run when the spec is updated.
 *
 * Parsing uses Playwright's Chromium (already a project dependency) so the real
 * DOM does the work — no HTML-parsing dependency, no brittle regex.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const htmlPath = join(rootDir, "WCAG_2.2.html");
const outDir = join(rootDir, "reference", "wcag");
const scDir = join(outDir, "sc");

if (!existsSync(htmlPath)) {
  console.error(`WCAG source not found: ${htmlPath}`);
  console.error(
    "Download the WCAG 2.2 single-page spec to WCAG_2.2.html, then re-run.",
  );
  process.exit(1);
}

const browser = await chromium.launch();
let data;
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(htmlPath).href, {
    waitUntil: "domcontentloaded",
  });
  data = await page.evaluate(extractWcag);
} finally {
  await browser.close();
}

if (!data.criteria.length) {
  console.error("No success criteria found — is WCAG_2.2.html the W3C spec?");
  process.exit(1);
}

writeReference(data);

/**
 * Runs inside the page. Walks every `bdi.secno` label, classifies it as a
 * principle, guideline, or success criterion, and pulls the structured content
 * for each. Definitions are read from the glossary `<dfn>` appendix.
 */
function extractWcag() {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  // innerText needs a rendered, in-document node, so build the body text from
  // the section's live children rather than a detached clone.
  const bodyText = (section) => {
    const parts = [];
    for (const child of section.children) {
      if (child.matches(".header-wrapper, .doclinks, .conformance-level"))
        continue;
      const text = (child.innerText || "").trim();
      if (text) parts.push(text);
    }
    return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  };

  const glossary = {};
  for (const dfn of document.querySelectorAll('dfn[id^="dfn-"]')) {
    const dt = dfn.closest("dt");
    const dd =
      dt && dt.nextElementSibling && dt.nextElementSibling.tagName === "DD"
        ? dt.nextElementSibling
        : null;
    glossary[dfn.id] = {
      id: dfn.id,
      term: clean(dfn.textContent),
      definition: dd
        ? (dd.innerText || "").replace(/\n{3,}/g, "\n\n").trim()
        : "",
    };
  }

  const principles = [];
  const guidelines = [];
  const criteria = [];

  for (const secno of document.querySelectorAll("bdi.secno")) {
    const label = clean(secno.textContent);
    const heading = secno.parentElement;
    const section = secno.closest("section");
    if (!heading || !section) continue;
    const title = clean(heading.textContent.replace(secno.textContent, ""));
    const num = (label.match(/(\d+(?:\.\d+)*)/) || [])[1] || "";

    // Principle headings carry only a bare number (`1.`); the word "Principle"
    // never appears, so the section class is the reliable signal. Guideline and
    // success-criterion headings are prefixed in the body copy.
    if (section.classList.contains("principle")) {
      principles.push({ num, title, slug: section.id });
    } else if (/^Guideline/i.test(label)) {
      guidelines.push({ num, title, slug: section.id });
    } else if (/^Success Criterion/i.test(label)) {
      const levelEl = section.querySelector("p.conformance-level");
      const level = levelEl
        ? (levelEl.textContent.match(/Level\s+(A+)/i) || [])[1] || ""
        : "";
      const links = {};
      for (const a of section.querySelectorAll(".doclinks a[href]")) {
        if (/Understanding/i.test(a.textContent)) links.understanding = a.href;
        if (/How to Meet/i.test(a.textContent)) links.howToMeet = a.href;
      }
      const defIds = [];
      for (const a of section.querySelectorAll('a.internalDFN[href^="#dfn-"]')) {
        const id = a.getAttribute("href").slice(1);
        if (!defIds.includes(id)) defIds.push(id);
      }
      criteria.push({
        num,
        title,
        slug: section.id,
        level,
        text: bodyText(section),
        understanding: links.understanding || "",
        howToMeet: links.howToMeet || "",
        defIds,
      });
    }
  }

  return { principles, guidelines, criteria, glossary };
}

/** Writes the four reference outputs from the extracted spec data. */
function writeReference(spec) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(scDir, { recursive: true });

  const principleOf = (num) => num.split(".")[0];
  const guidelineOf = (num) => num.split(".").slice(0, 2).join(".");
  const principleByNum = new Map(spec.principles.map((p) => [p.num, p]));
  const guidelineByNum = new Map(spec.guidelines.map((g) => [g.num, g]));
  const fileName = (sc) => `${sc.num}-${sc.slug}.md`;

  // --- per-criterion files ------------------------------------------------
  for (const sc of spec.criteria) {
    const principle = principleByNum.get(principleOf(sc.num));
    const guideline = guidelineByNum.get(guidelineOf(sc.num));
    const defs = sc.defIds
      .map((id) => spec.glossary[id])
      .filter((d) => d && d.definition);

    const lines = [
      `# ${sc.num} ${sc.title}`,
      "",
      `- Level: ${sc.level || "unknown"}`,
      principle
        ? `- Principle: ${principle.num} ${principle.title}`
        : undefined,
      guideline
        ? `- Guideline: ${guideline.num} ${guideline.title}`
        : undefined,
      sc.understanding ? `- Understanding: ${sc.understanding}` : undefined,
      sc.howToMeet ? `- How to meet: ${sc.howToMeet}` : undefined,
      "",
      "## Requirement",
      "",
      sc.text || "(no normative text extracted)",
    ].filter((line) => line !== undefined);

    if (defs.length) {
      lines.push("", "## Definitions used");
      for (const def of defs) lines.push("", `### ${def.term}`, "", def.definition);
    }
    writeFileSync(join(scDir, fileName(sc)), `${lines.join("\n")}\n`);
  }

  // --- tree index ---------------------------------------------------------
  const index = [
    "# WCAG 2.2 reference index",
    "",
    "Generated from the W3C WCAG 2.2 spec by `scripts/build-wcag.mjs` — do not",
    "edit by hand. This is the principle -> guideline -> success criterion tree.",
    "",
    "Read one criterion's normative text at `reference/wcag/sc/<file>` only when",
    "you need it; do not load every criterion. Compact axe violations already",
    "carry a `wcag` array naming the criteria they map to. Term definitions are",
    "in `reference/wcag/glossary.md`.",
    "",
    `Coverage: ${spec.principles.length} principles, ${spec.guidelines.length} guidelines, ${spec.criteria.length} success criteria.`,
  ];
  for (const principle of spec.principles) {
    index.push("", `## Principle ${principle.num} — ${principle.title}`);
    const guidelines = spec.guidelines.filter(
      (g) => principleOf(g.num) === principle.num,
    );
    for (const guideline of guidelines) {
      index.push("", `### Guideline ${guideline.num} — ${guideline.title}`, "");
      const criteria = spec.criteria.filter(
        (sc) => guidelineOf(sc.num) === guideline.num,
      );
      for (const sc of criteria)
        index.push(
          `- **${sc.num}** ${sc.title} — Level ${sc.level || "?"} — \`sc/${fileName(sc)}\``,
        );
    }
  }
  writeFileSync(join(outDir, "index.md"), `${index.join("\n")}\n`);

  // --- glossary -----------------------------------------------------------
  const glossary = [
    "# WCAG 2.2 glossary",
    "",
    "Generated by `scripts/build-wcag.mjs` — do not edit by hand.",
  ];
  for (const def of Object.values(spec.glossary).sort((a, b) =>
    a.term.localeCompare(b.term),
  )) {
    if (!def.definition) continue;
    glossary.push("", `## ${def.term}`, "", def.definition);
  }
  writeFileSync(join(outDir, "glossary.md"), `${glossary.join("\n")}\n`);

  // --- machine map: SC lookup + exact axe-tag index -----------------------
  // axe-core tags WCAG rules as `wcag` + the SC number with dots removed
  // (1.4.3 -> wcag143). Emitting the index from the real SC numbers keeps the
  // mapping exact instead of guessing digit boundaries.
  const criteria = {};
  const tags = {};
  for (const sc of spec.criteria) {
    criteria[sc.num] = {
      title: sc.title,
      level: sc.level,
      slug: sc.slug,
      file: `sc/${fileName(sc)}`,
    };
    tags[`wcag${sc.num.replace(/\./g, "")}`] = sc.num;
  }
  writeFileSync(
    join(outDir, "wcag-map.json"),
    `${JSON.stringify(
      { version: "WCAG 2.2", generated: new Date().toISOString(), criteria, tags },
      null,
      2,
    )}\n`,
  );

  const scFiles = readdirSync(scDir).length;
  console.log(
    `WCAG reference written to ${join("reference", "wcag")}: ` +
      `${scFiles} criterion files, ${Object.keys(spec.glossary).length} glossary terms.`,
  );
}
