import { z } from "zod";

export type PatchBlock = { search: string; replace: string };

export type PatchResult =
  | { ok: true; appliedCount: number; updatedHtml: string }
  | { ok: false; error: "ambiguous" | "no_match" | "parse_error"; details: string; failedBlock?: PatchBlock };

/**
 * Parse Aider-style SEARCH/REPLACE blocks from raw LLM output.
 *
 * Expected format per block:
 *   <<<<<<< SEARCH
 *   <exact text to find>
 *   =======
 *   <replacement text>
 *   >>>>>>> REPLACE
 */
export function parsePatches(rawOutput: string): { blocks: PatchBlock[]; warnings: string[] } {
  const blocks: PatchBlock[] = [];
  const warnings: string[] = [];

  const normalized = rawOutput.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const BLOCK_RE = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(normalized)) !== null) {
    blocks.push({ search: m[1], replace: m[2] });
  }

  const totalSearchMarkers = (normalized.match(/<<<<<<< SEARCH/g) ?? []).length;
  if (totalSearchMarkers !== blocks.length) {
    warnings.push(
      `${totalSearchMarkers} SEARCH marker(s) found but only ${blocks.length} complete block(s) parsed — check for missing ======= or >>>>>>> REPLACE`,
    );
  }

  return { blocks, warnings };
}

function normalizeTrailingWs(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

function replaceFirst(source: string, search: string, replace: string): string {
  const idx = source.indexOf(search);
  if (idx === -1) return source;
  return source.slice(0, idx) + replace + source.slice(idx + search.length);
}

function applySingleBlock(
  html: string,
  block: PatchBlock,
): { ok: true; result: string } | { ok: false; matchCount: number } {
  // Pass 1: exact string match
  const exactCount = countOccurrences(html, block.search);
  if (exactCount === 1) {
    return { ok: true, result: replaceFirst(html, block.search, block.replace) };
  }
  if (exactCount > 1) {
    return { ok: false, matchCount: exactCount };
  }

  // Pass 2: retry with per-line trailing-whitespace normalization
  const normHtml = normalizeTrailingWs(html);
  const normSearch = normalizeTrailingWs(block.search);
  const normReplace = normalizeTrailingWs(block.replace);

  const normCount = countOccurrences(normHtml, normSearch);
  if (normCount === 1) {
    return { ok: true, result: replaceFirst(normHtml, normSearch, normReplace) };
  }

  return { ok: false, matchCount: normCount };
}

/**
 * Apply patch blocks atomically: all succeed or none are applied.
 * Blocks are applied sequentially so each patch sees the result of the previous.
 */
export function applyPatches(html: string, blocks: PatchBlock[]): PatchResult {
  if (blocks.length === 0) {
    return { ok: true, appliedCount: 0, updatedHtml: html };
  }

  for (const block of blocks) {
    if (block.search.trim() === "") {
      return {
        ok: false,
        error: "parse_error",
        details: "SEARCH block is empty — cannot match against empty string",
        failedBlock: block,
      };
    }
  }

  let current = html;

  for (const block of blocks) {
    const result = applySingleBlock(current, block);
    if (!result.ok) {
      return {
        ok: false,
        error: result.matchCount === 0 ? "no_match" : "ambiguous",
        details:
          result.matchCount === 0
            ? "SEARCH text not found in document (tried exact match and trailing-whitespace-normalized match)"
            : `SEARCH text appears ${result.matchCount} times — must be unique`,
        failedBlock: block,
      };
    }
    current = result.result;
  }

  return { ok: true, appliedCount: blocks.length, updatedHtml: current };
}

// ---------------------------------------------------------------------------
// LLM output schema — the shape the fixer LLM must produce when called
// directly (not via opencode). Imported by both accessibility.ts (for the
// system-prompt description) and core.ts (for callLLM validation).
// ---------------------------------------------------------------------------

export const FIX_PATCH_SCHEMA = z.object({
  patches: z.array(
    z.object({
      findingId: z.string(),
      search: z.string(),
      replace: z.string(),
      rationale: z.string(),
    }),
  ),
  summary: z.string(),
  unfixed: z.array(z.string()).optional(),
});

export type FixPatchResult = z.infer<typeof FIX_PATCH_SCHEMA>;
