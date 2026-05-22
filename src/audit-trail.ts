import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * EU AI Act-aligned audit trail with hash-chain tamper evidence.
 *
 * Article 12 (record-keeping): every automated decision traceable to its source.
 * Article 13 (transparency): inputs, model used, output, reasoning all logged.
 * Article 14 (human oversight): records support meaningful review and override.
 * Article 15 (accuracy & robustness): confidence + evidence + disagreement tracked.
 *
 * One audit record per significant action (LLM call, deterministic aggregate,
 * deterministic decision, check). Records are append-only and linked via
 * SHA-256 hash chain so an auditor can verify the trail was not modified
 * after the fact.
 *
 * Files written:
 *   evidence-trail/index.json     — full index for programmatic access
 *   evidence-trail/<recordId>.json — one file per record for human inspection
 *   evidence-trail/hash-chain.txt  — append-only chain log
 */

export type ActionType =
  | "scan"
  | "brief"
  | "findings"
  | "aggregate"
  | "fix"
  | "check"
  | "vote"
  | "decide"
  | "report"
  | "narrative";

export type AuditRecord = {
  recordId: string;
  timestamp: string;
  runId: string;
  iteration?: number;
  actionType: ActionType;

  // Who acted (Article 13 transparency)
  agentKey: string;
  agentRole: string;
  /** Whether this action was performed by an LLM or by deterministic code. */
  executor: "llm" | "deterministic" | "tool";

  // Model details (only present when executor === "llm")
  modelProvider?: string;
  modelId?: string;
  modelVariant?: string;

  // Input provenance (Article 15 accuracy)
  /** SHA-256 of the prompt text, if any. */
  promptHash?: string;
  /** Path to saved prompt file for inspection. */
  promptPath?: string;
  /** Hashes of input files read by this action. */
  inputFilesHashes?: Record<string, string>;

  // Output
  outputPaths: string[];
  outputSummary?: string;

  // Linkage (Article 12 traceability)
  parentRecordId?: string;
  supersedes?: string[];

  // Resources (Article 9 risk management transparency)
  elapsedMs: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUSD?: number;
  estimatedEnergyKWh?: number;

  // Confidence (Article 15)
  confidence?: "low" | "medium" | "high";

  // Hash chain
  previousRecordHash?: string;
  recordHash: string;
};

export type AuditTrailOptions = {
  runDir: string;
  runId: string;
};

export class AuditTrail {
  private dir: string;
  private indexFile: string;
  private chainFile: string;
  private records: AuditRecord[] = [];
  private lastHash?: string;
  private sequenceNum = 0;

  constructor(private opts: AuditTrailOptions) {
    this.dir = join(opts.runDir, "evidence-trail");
    this.indexFile = join(this.dir, "index.json");
    this.chainFile = join(this.dir, "hash-chain.txt");
    mkdirSync(this.dir, { recursive: true });
    this.loadExisting();
  }

  private loadExisting(): void {
    if (!existsSync(this.indexFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.indexFile, "utf8")) as {
        records?: AuditRecord[];
        lastHash?: string;
      };
      if (Array.isArray(data.records)) {
        this.records = data.records;
        this.sequenceNum = this.records.length;
        this.lastHash = data.lastHash || this.records[this.records.length - 1]?.recordHash;
      }
    } catch {
      // start fresh
    }
  }

  /**
   * Record an action. Returns the saved record (with computed recordId and hash)
   * so the caller can link follow-up actions via parentRecordId.
   */
  record(
    input: Omit<
      AuditRecord,
      "recordId" | "recordHash" | "previousRecordHash" | "timestamp"
    >,
  ): AuditRecord {
    this.sequenceNum++;
    const recordId = `${this.opts.runId}-${String(this.sequenceNum).padStart(3, "0")}-${input.actionType}-${input.agentKey}`;
    const timestamp = new Date().toISOString();

    const partial: Omit<AuditRecord, "recordHash"> = {
      ...input,
      recordId,
      timestamp,
      previousRecordHash: this.lastHash,
    };

    const recordHash = hashRecord(partial);
    const record: AuditRecord = { ...partial, recordHash };

    this.records.push(record);
    this.lastHash = recordHash;

    // Individual record file (human-readable inspection)
    writeFileSync(
      join(this.dir, `${recordId}.json`),
      JSON.stringify(record, null, 2),
    );

    // Chain log entry
    const chainLine = `${timestamp} ${recordId} ${recordHash}${input.parentRecordId ? ` parent=${input.parentRecordId}` : ""}\n`;
    appendFileSync(this.chainFile, chainLine);

    return record;
  }

  /** Persist the consolidated index. Call at end of run. */
  flush(): void {
    writeFileSync(
      this.indexFile,
      JSON.stringify(
        {
          runId: this.opts.runId,
          recordCount: this.records.length,
          lastHash: this.lastHash,
          generatedAt: new Date().toISOString(),
          chainValid: this.verify().valid,
          records: this.records,
        },
        null,
        2,
      ),
    );
  }

  /** Verify the hash chain — for compliance audit. */
  verify(): { valid: boolean; brokenAt?: string; error?: string } {
    let prevHash: string | undefined;
    for (const record of this.records) {
      if (record.previousRecordHash !== prevHash) {
        return {
          valid: false,
          brokenAt: record.recordId,
          error: `chain link broken: expected previous=${prevHash || "(none)"}, got ${record.previousRecordHash || "(none)"}`,
        };
      }
      const recomputed = hashRecord({
        ...record,
        recordHash: undefined as unknown as string,
      });
      if (recomputed !== record.recordHash) {
        return {
          valid: false,
          brokenAt: record.recordId,
          error: `record hash mismatch — content was modified after writing`,
        };
      }
      prevHash = record.recordHash;
    }
    return { valid: true };
  }

  /** Find the most recent record for a given agent + action type. */
  findLatest(agentKey: string, actionType: ActionType): AuditRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (r.agentKey === agentKey && r.actionType === actionType) return r;
    }
    return undefined;
  }

  getRecords(): AuditRecord[] {
    return [...this.records];
  }
}

// ---------- Helpers ----------

function hashRecord(record: Partial<AuditRecord>): string {
  // Canonical JSON: sort keys, exclude recordHash itself
  const keys = Object.keys(record)
    .filter((k) => k !== "recordHash")
    .sort();
  const canonical: Record<string, unknown> = {};
  for (const k of keys) {
    canonical[k] = (record as Record<string, unknown>)[k];
  }
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function hashFile(path: string): string {
  if (!existsSync(path)) return "";
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Build a Record<filePath, hash> for the given paths. Used by callers to fill
 * the inputFilesHashes field on an audit record.
 */
export function hashInputFiles(paths: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const p of paths) {
    const h = hashFile(p);
    if (h) result[p] = h;
  }
  return result;
}
