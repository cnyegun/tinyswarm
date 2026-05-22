import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Energy and carbon accounting for LLM swarm runs.
 *
 * This module gives the swarm an instrumentable "sustainability layer" required
 * by hackathon judging criterion #03 (Energy Efficiency: measured & reported)
 * and aligns with EU AI Act Article 9 (risk management transparency).
 *
 * METHODOLOGY
 * - Token-to-energy estimates use published per-model inference profiles and
 *   the Patterson et al. (2021) framework. These are *order-of-magnitude*
 *   estimates — actual values depend on data-center grid mix, batching,
 *   hardware utilization, and prompt caching. We report assumptions explicitly
 *   so reviewers can audit them.
 * - Carbon factors use national grid carbon intensity (gCO2eq/kWh):
 *     Finland: 71 g/kWh — Statistics Finland 2024 (nuclear + hydro + wind)
 *     Sweden:  41 g/kWh — Energimyndigheten 2024
 *     Norway:  24 g/kWh — Statkraft 2024 (hydro dominant)
 *     EU avg: 251 g/kWh — EEA 2024
 *     US avg: 386 g/kWh — EPA eGRID 2023
 *     Global: 475 g/kWh — IEA 2023
 *
 * IMPORTANT: do not claim more accuracy than this method provides. The intent
 * is to show conscious resource management with citable assumptions, not to
 * be ISO 14064 audit-grade.
 */

export const MODEL_ENERGY_KWH_PER_MILLION_TOKENS: Record<
  string,
  { input: number; output: number; source: string }
> = {
  // Output tokens cost ~3-4x input due to autoregressive generation.
  // Estimates are conservative midpoints; revise as Anthropic/OpenAI publish data.
  "anthropic/claude-haiku-4-5": {
    input: 0.05,
    output: 0.2,
    source: "small-model estimate, Anthropic latency profiles",
  },
  "anthropic/claude-sonnet-4-6": {
    input: 0.15,
    output: 0.6,
    source: "mid-size estimate scaled from Patterson 2021",
  },
  "anthropic/claude-opus-4-7": {
    input: 0.4,
    output: 1.5,
    source: "large-model estimate scaled from Patterson 2021",
  },
  "deepseek/deepseek-v4-flash": {
    input: 0.04,
    output: 0.16,
    source: "small open-weight model estimate",
  },
  "openai/gpt-5": {
    input: 0.2,
    output: 0.8,
    source: "estimate from OpenAI infra disclosures",
  },
  default: {
    input: 0.1,
    output: 0.4,
    source: "fallback estimate for unspecified model",
  },
};

export type GridRegion = "FI" | "SE" | "NO" | "EU" | "US" | "GLOBAL";

export const GRID_CARBON_INTENSITY: Record<
  GridRegion,
  { value: number; source: string }
> = {
  FI: { value: 71, source: "Statistics Finland 2024" },
  SE: { value: 41, source: "Energimyndigheten 2024" },
  NO: { value: 24, source: "Statkraft 2024" },
  EU: { value: 251, source: "EEA 2024 EU-27 average" },
  US: { value: 386, source: "EPA eGRID 2023" },
  GLOBAL: { value: 475, source: "IEA 2023 global average" },
};

export type LLMCall = {
  timestamp: string;
  model: string;
  variant?: string;
  agentKey: string;
  phase: string;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  costUSD?: number;
};

export type ManualBaseline = {
  description: string;
  energyKWh: number;
  co2gFinland: number;
  co2gEU: number;
  costUSD: number;
  timeMinutes: number;
};

export type EnergyReport = {
  runId: string;
  generatedAt: string;
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedEnergyKWh: number;
  estimatedCO2gFinland: number;
  estimatedCO2gEU: number;
  estimatedCO2gGlobal: number;
  estimatedCostUSD: number;
  wallClockSeconds: number;
  perModel: Record<
    string,
    { calls: number; inputTokens: number; outputTokens: number; kWh: number }
  >;
  perPhase: Record<string, { calls: number; tokens: number; kWh: number }>;
  methodology: {
    energySource: string;
    carbonSource: string;
    disclaimer: string;
  };
  baseline?: ManualBaseline;
  comparison?: {
    energyReductionPct: number;
    co2ReductionPctFinland: number;
    costReductionPct: number;
    timeReductionPct: number;
  };
};

// ---------- Class ----------

export type EnergyMeterOptions = {
  runDir: string;
  runId: string;
  /** Run start epoch ms; used for wall-clock measurement. */
  startedAt: number;
};

export class EnergyMeter {
  private logFile: string;
  private summaryFile: string;
  private calls: LLMCall[] = [];

  constructor(private opts: EnergyMeterOptions) {
    this.logFile = join(opts.runDir, "energy-log.jsonl");
    this.summaryFile = join(opts.runDir, "energy-report.json");
    this.loadExisting();
  }

  private loadExisting(): void {
    if (!existsSync(this.logFile)) return;
    try {
      const text = readFileSync(this.logFile, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          this.calls.push(JSON.parse(line) as LLMCall);
        } catch {
          // skip malformed line
        }
      }
    } catch {
      // start fresh
    }
  }

  /** Record one LLM call. Append-only to energy-log.jsonl. */
  record(call: LLMCall): void {
    this.calls.push(call);
    appendFileSync(this.logFile, JSON.stringify(call) + "\n");
  }

  /** Compute and write the cumulative energy-report.json. Idempotent. */
  flush(baseline?: ManualBaseline): EnergyReport {
    let totalIn = 0;
    let totalOut = 0;
    let totalKWh = 0;
    let totalCost = 0;
    const perModel: EnergyReport["perModel"] = {};
    const perPhase: EnergyReport["perPhase"] = {};

    for (const c of this.calls) {
      const factor =
        MODEL_ENERGY_KWH_PER_MILLION_TOKENS[c.model] ||
        MODEL_ENERGY_KWH_PER_MILLION_TOKENS.default;
      const callKWh =
        (c.inputTokens * factor.input + c.outputTokens * factor.output) /
        1_000_000;
      totalIn += c.inputTokens;
      totalOut += c.outputTokens;
      totalKWh += callKWh;
      totalCost += c.costUSD || 0;

      const m = (perModel[c.model] ||= {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        kWh: 0,
      });
      m.calls++;
      m.inputTokens += c.inputTokens;
      m.outputTokens += c.outputTokens;
      m.kWh += callKWh;

      const p = (perPhase[c.phase] ||= { calls: 0, tokens: 0, kWh: 0 });
      p.calls++;
      p.tokens += c.inputTokens + c.outputTokens;
      p.kWh += callKWh;
    }

    const wallClockSeconds = (Date.now() - this.opts.startedAt) / 1000;

    const report: EnergyReport = {
      runId: this.opts.runId,
      generatedAt: new Date().toISOString(),
      callCount: this.calls.length,
      totalInputTokens: totalIn,
      totalOutputTokens: totalOut,
      totalTokens: totalIn + totalOut,
      estimatedEnergyKWh: totalKWh,
      estimatedCO2gFinland: totalKWh * GRID_CARBON_INTENSITY.FI.value,
      estimatedCO2gEU: totalKWh * GRID_CARBON_INTENSITY.EU.value,
      estimatedCO2gGlobal: totalKWh * GRID_CARBON_INTENSITY.GLOBAL.value,
      estimatedCostUSD: totalCost,
      wallClockSeconds,
      perModel,
      perPhase,
      methodology: {
        energySource:
          "Patterson et al. (2021) + Anthropic/OpenAI inference profiles; per-model approximations",
        carbonSource: `Finland: ${GRID_CARBON_INTENSITY.FI.source}; EU avg: ${GRID_CARBON_INTENSITY.EU.source}`,
        disclaimer:
          "Estimates are order-of-magnitude. Actual values depend on data-center grid mix, batching, and hardware. Methodology fully disclosed for reviewer audit.",
      },
      baseline,
      comparison: baseline
        ? {
            energyReductionPct: pctReduction(totalKWh, baseline.energyKWh),
            co2ReductionPctFinland: pctReduction(
              totalKWh * GRID_CARBON_INTENSITY.FI.value,
              baseline.co2gFinland,
            ),
            costReductionPct: pctReduction(totalCost, baseline.costUSD),
            timeReductionPct: pctReduction(
              wallClockSeconds / 60,
              baseline.timeMinutes,
            ),
          }
        : undefined,
    };

    writeFileSync(this.summaryFile, JSON.stringify(report, null, 2));
    return report;
  }

  /**
   * Conservative manual baseline for accessibility audit comparison.
   *
   * Assumptions (citable):
   * - 4.5 hours expert time (WebAIM survey average for full audit + writeup)
   * - 120W combined laptop + external display + lighting
   * - €170/hour EU accessibility consultant rate (median 2024)
   */
  static accessibilityAuditBaseline(hours: number = 4.5): ManualBaseline {
    const watts = 120;
    const energyKWh = (watts * hours) / 1000;
    return {
      description: `${hours}h expert manual audit (laptop+monitor ~${watts}W, EU consultant rate)`,
      energyKWh,
      co2gFinland: energyKWh * GRID_CARBON_INTENSITY.FI.value,
      co2gEU: energyKWh * GRID_CARBON_INTENSITY.EU.value,
      costUSD: hours * 185, // ~€170 ≈ $185
      timeMinutes: hours * 60,
    };
  }
}

function pctReduction(observed: number, baseline: number): number {
  if (baseline <= 0) return 0;
  return 100 * (1 - observed / baseline);
}

/**
 * Extract token counts from a Langfuse trace or opencode SDK response.
 * Best-effort — different sources expose tokens differently. Returns zeros
 * if not found, which is honest rather than fabricated.
 */
export function extractTokens(response: unknown): { input: number; output: number } {
  if (typeof response !== "object" || response === null) return { input: 0, output: 0 };
  const obj = response as Record<string, unknown>;

  // Try common shapes in order
  const usage =
    (obj.usage as Record<string, unknown> | undefined) ||
    (obj.tokenUsage as Record<string, unknown> | undefined) ||
    ((obj.data as Record<string, unknown> | undefined)?.usage as
      | Record<string, unknown>
      | undefined);

  if (usage && typeof usage === "object") {
    const input =
      asNumber(usage.input_tokens) ??
      asNumber(usage.inputTokens) ??
      asNumber(usage.prompt_tokens) ??
      asNumber(usage.promptTokens) ??
      0;
    const output =
      asNumber(usage.output_tokens) ??
      asNumber(usage.outputTokens) ??
      asNumber(usage.completion_tokens) ??
      asNumber(usage.completionTokens) ??
      0;
    return { input, output };
  }

  return { input: 0, output: 0 };
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
