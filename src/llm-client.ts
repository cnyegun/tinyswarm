import { z } from "zod";

/**
 * Skinny direct LLM client for DeepSeek (OpenAI-compatible API).
 *
 * Bypasses opencode entirely — no session overhead, no polling, synchronous
 * response. Typical latency: 3-8s vs 15-30s via opencode, for the structured
 * JSON outputs used by reviewer and brief/report agents.
 *
 * Only the deepseek/* provider is wired. Add anthropic/* or openai/* entries
 * to `dispatch` when those API keys become available.
 */

// ---------- Public API ----------

export type LLMCallOptions<TSchema extends z.ZodType> = {
  /** Full "provider/model-id" string, e.g. "deepseek/deepseek-v4-flash". */
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** Zod schema the parsed JSON response must conform to. */
  outputSchema: TSchema;
  /** Max output tokens. Default 4000. */
  maxTokens?: number;
  /** Sampling temperature. Default 0 (deterministic). */
  temperature?: number;
  /** Request JSON-mode from the API (response_format: json_object). Default false. */
  jsonMode?: boolean;
};

export type LLMCallResult<TSchema extends z.ZodType> = {
  data: z.infer<TSchema>;
  usage: { inputTokens: number; outputTokens: number };
  rawText: string;
  elapsedMs: number;
};

export async function callLLM<TSchema extends z.ZodType>(
  opts: LLMCallOptions<TSchema>,
): Promise<LLMCallResult<TSchema>> {
  const {
    model,
    systemPrompt,
    userPrompt,
    outputSchema,
    maxTokens = 4000,
    temperature = 0,
    jsonMode = false,
  } = opts;
  const started = Date.now();

  const slashIdx = model.indexOf("/");
  if (slashIdx === -1)
    throw new Error(`callLLM: model must be "provider/id", got "${model}"`);
  const providerID = model.slice(0, slashIdx);
  const modelId = model.slice(slashIdx + 1);

  // Initial call
  let raw = await dispatch(providerID, modelId, systemPrompt, userPrompt, maxTokens, temperature, jsonMode);

  // Validate; retry once on schema/JSON failure
  let parsed = tryParse(outputSchema, raw.rawText);
  if (!parsed.success) {
    const retryPrompt =
      `Your previous response was not valid JSON matching the required schema.\n` +
      `Errors: ${parsed.errorMsg}\n\n` +
      `Previous response:\n${raw.rawText}\n\n` +
      `Respond with valid JSON only. No explanation, no markdown fences.`;
    const retried = await dispatch(providerID, modelId, systemPrompt, retryPrompt, maxTokens, temperature, jsonMode);
    raw = {
      rawText: retried.rawText,
      usage: {
        inputTokens: raw.usage.inputTokens + retried.usage.inputTokens,
        outputTokens: raw.usage.outputTokens + retried.usage.outputTokens,
      },
    };
    parsed = tryParse(outputSchema, raw.rawText);
    if (!parsed.success) {
      throw new Error(
        `callLLM: schema validation failed after retry.\n` +
          `Model: ${model}\n` +
          `Errors: ${parsed.errorMsg}\n` +
          `Raw response: ${raw.rawText.slice(0, 600)}`,
      );
    }
  }

  return {
    data: parsed.data as z.infer<TSchema>,
    usage: raw.usage,
    rawText: raw.rawText,
    elapsedMs: Date.now() - started,
  };
}

// ---------- Provider dispatch ----------

type RawResult = { rawText: string; usage: { inputTokens: number; outputTokens: number } };

function dispatch(
  providerID: string,
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  temperature: number,
  jsonMode: boolean,
): Promise<RawResult> {
  switch (providerID) {
    case "deepseek":
      return callOpenAICompat(
        "https://api.deepseek.com",
        requireKey("DEEPSEEK_API_KEY"),
        modelId,
        systemPrompt,
        userPrompt,
        maxTokens,
        temperature,
        jsonMode,
      );
    case "anthropic":
      requireKey("ANTHROPIC_API_KEY");
      throw new Error(`callLLM: anthropic provider not yet wired — install @anthropic-ai/sdk.`);
    case "openai":
      requireKey("OPENAI_API_KEY");
      throw new Error(`callLLM: openai provider not yet wired — add fetch-based implementation.`);
    default:
      throw new Error(
        `callLLM: unknown provider "${providerID}". Only deepseek/* is supported.`,
      );
  }
}

// ---------- DeepSeek (OpenAI-compatible) ----------

type OAIResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string; code?: unknown };
};

async function callOpenAICompat(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  temperature: number,
  jsonMode: boolean,
): Promise<RawResult> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(`callLLM HTTP ${res.status} from ${baseUrl}: ${body.slice(0, 400)}`);
  }

  const json = (await res.json()) as OAIResponse;
  if (json.error) {
    throw new Error(
      `callLLM API error from ${baseUrl}: ${json.error.message ?? JSON.stringify(json.error)}`,
    );
  }

  const rawText = json.choices?.[0]?.message?.content ?? "";
  return {
    rawText,
    usage: {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------- JSON extraction and validation ----------

/** Strip markdown fences and find outermost JSON object/array in raw LLM output. */
function extractJSON(rawText: string): string {
  const trimmed = rawText.trim();

  // ```json ... ``` or ``` ... ```
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenced) return fenced[1].trim();

  // Find outermost { } or [ ] span
  const start = trimmed.search(/[{[]/);
  if (start === -1) return trimmed;
  const lastBrace = trimmed.lastIndexOf("}");
  const lastBracket = trimmed.lastIndexOf("]");
  const end = Math.max(lastBrace, lastBracket);
  if (end > start) return trimmed.slice(start, end + 1);

  return trimmed;
}

type ParseSuccess<T> = { success: true; data: T };
type ParseFailure = { success: false; errorMsg: string };

function tryParse<TSchema extends z.ZodType>(
  schema: TSchema,
  rawText: string,
): ParseSuccess<z.infer<TSchema>> | ParseFailure {
  let json: unknown;
  try {
    json = JSON.parse(extractJSON(rawText));
  } catch (e) {
    return {
      success: false,
      errorMsg: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const result = schema.safeParse(json);
  if (result.success) return { success: true, data: result.data };

  const errorMsg = result.error.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
  return { success: false, errorMsg };
}

// ---------- Utilities ----------

function requireKey(envVar: string): string {
  const key = process.env[envVar];
  if (!key) throw new Error(`callLLM: ${envVar} is not set — add it to .env`);
  return key;
}
