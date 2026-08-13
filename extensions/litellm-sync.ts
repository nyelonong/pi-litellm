/**
 * LiteLLM Model Sync Extension for Pi
 *
 * Keeps the Pi model selector in sync with LiteLLM's live model list.
 * On startup (and on /reload), fetches GET /v1/models from LiteLLM and
 * calls pi.registerProvider("litellm", ...) with the exact model IDs
 * that LiteLLM exposes — so the selector shows "bedrock/claude-sonnet-4.6"
 * rather than stale IDs baked into models.json.
 *
 * Configuration:
 *   Set LITELLM_BASE_URL env var or configure in models.json provider config
 *   Set LITELLM_API_KEY env var or configure in models.json provider config
 *
 * Priority: env vars > models.json provider config > defaults
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LiteLLMModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface LiteLLMModelsResponse {
  data: LiteLLMModel[];
  object: string;
}

interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  api: string;
  declared: Map<string, ModelCaps>; // hand-written per-model overrides from models.json
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive display name from model id, e.g. "bedrock/claude-sonnet-4.6" → "Claude Sonnet 4.6 (Bedrock)" */
function displayName(id: string): string {
  const [prefix, ...rest] = id.split("/");
  const modelPart = rest.join("/");
  if (!modelPart) return id;

  const prefixLabel: Record<string, string> = {
    bedrock: "Bedrock",
    openrouter: "OpenRouter",
    openai: "OpenAI",
    azure: "Azure",
    vertex_ai: "Vertex AI",
    anthropic: "Anthropic",
    ollama: "Ollama",
  };

  const label = prefixLabel[prefix] ?? prefix.charAt(0).toUpperCase() + prefix.slice(1);
  const human = modelPart
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return `${human} (${label})`;
}

/** Build the model-list endpoint from the configured base URL */
export function modelsUrl(baseUrl: string): string {
  // Pi's own provider block wants a baseUrl ending in /v1, so most configs already carry it.
  const origin = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${origin}/v1/models`;
}

/** Capabilities for one model. Every field is optional: an omitted field means "not known here". */
export interface ModelCaps {
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
}

// Used only when neither the id heuristic nor models.json says anything.
export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_TOKENS = 16384;

const EFFORT_WITH_XHIGH ={ low: "low", medium: "medium", high: "high", xhigh: "xhigh" };
const EFFORT_XHIGH_AS_MAX = { low: "low", medium: "medium", high: "high", xhigh: "max" };
const EFFORT_NO_XHIGH = { low: "low", medium: "medium", high: "high", xhigh: null };

function claudeMeta(lower: string): ModelCaps | null {
  const isFable = lower.includes("fable") || lower.includes("mythos");
  // 4.5 was the first reasoning tier; anything older falls through as unknown.
  if (!isFable && !/(?:opus|sonnet|haiku)[-.]?(?:4[-.]?[5-9]|5)/.test(lower)) return null;

  // Haiku kept a 200K window and a 64K output cap while the other tiers moved to 1M.
  // It takes no effort parameter, so it reasons on no path this provider can reach.
  if (lower.includes("haiku")) {
    return { reasoning: false, contextWindow: 200000, maxTokens: 64000 };
  }
  if (isFable || lower.includes("opus")) {
    return { reasoning: true, contextWindow: 1000000, maxTokens: 128000, thinkingLevelMap: EFFORT_WITH_XHIGH };
  }
  if (lower.includes("sonnet")) {
    return { reasoning: true, contextWindow: 1000000, maxTokens: 128000, thinkingLevelMap: EFFORT_XHIGH_AS_MAX };
  }
  return null;
}

function gptMeta(lower: string): ModelCaps {
  if (/gpt-5[-.]?6/.test(lower)) {
    return { reasoning: true, contextWindow: 1050000, maxTokens: 128000, thinkingLevelMap: EFFORT_WITH_XHIGH };
  }
  // The rest of the GPT-5 line reasons too, but its windows are not known here.
  return { reasoning: true };
}

/**
 * Capabilities inferred from a model id, or null when the id is unrecognized.
 * Returning null rather than a default is what keeps a guess from overwriting models.json.
 */
export function modelMeta(id: string): ModelCaps | null {
  const lower = id.toLowerCase();
  if (lower.includes("claude")) return claudeMeta(lower);
  if (/gpt-5/.test(lower)) return gptMeta(lower);
  return null;
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

function resolveConfig(): ProviderConfig {
  const defaults: ProviderConfig = {
    baseUrl: "http://localhost:4000",
    apiKey: "sk-cedar-local",
    api: "anthropic-messages",
    declared: new Map(),
  };

  // Try reading from models.json for non-env-var config
  let fromModelsJson: Partial<ProviderConfig> = {};
  const modelsJsonPath = join(homedir(), ".pi", "agent", "models.json");
  if (existsSync(modelsJsonPath)) {
    try {
      const raw = readFileSync(modelsJsonPath, "utf-8");
      // Strip // comments before parsing
      const stripped = raw
        .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
        .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
      const parsed = JSON.parse(stripped) as { providers?: Record<string, any> };
      const p = parsed?.providers?.litellm ?? {};
      const declared = new Map<string, ModelCaps>();
      for (const m of (p.models ?? []) as Array<Record<string, any>>) {
        if (typeof m?.id !== "string") continue;
        declared.set(m.id, {
          reasoning: m.reasoning,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          thinkingLevelMap: m.thinkingLevelMap,
        });
      }
      fromModelsJson = {
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        api: p.api,
        declared,
      };
    } catch {
      // Ignore parse errors — fall through to defaults
    }
  }

  // Priority: env vars > models.json > defaults
  return {
    baseUrl: process.env.LITELLM_BASE_URL ?? fromModelsJson.baseUrl ?? defaults.baseUrl,
    apiKey: process.env.LITELLM_API_KEY ?? fromModelsJson.apiKey ?? defaults.apiKey,
    api: fromModelsJson.api ?? defaults.api,
    declared: fromModelsJson.declared ?? defaults.declared,
  };
}

// ---------------------------------------------------------------------------
// Core sync function
// ---------------------------------------------------------------------------

async function syncModels(pi: ExtensionAPI): Promise<void> {
  const config = resolveConfig();

  let models: LiteLLMModel[];
  try {
    const res = await fetch(modelsUrl(config.baseUrl), {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const payload = (await res.json()) as LiteLLMModelsResponse;
    models = payload.data ?? [];
  } catch (err) {
    console.error(
      `[litellm-sync] Failed to fetch models from ${config.baseUrl}: ${err instanceof Error ? err.message : err}`
    );
    return;
  }

  if (models.length === 0) {
    console.warn("[litellm-sync] No models returned from LiteLLM — skipping registration.");
    return;
  }

  pi.registerProvider("litellm", {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    api: config.api as any,
    models: models.map((m) => {
      // A hand-written models.json entry outranks the id heuristic, field by field.
      const guess = modelMeta(m.id) ?? {};
      const declared = config.declared.get(m.id) ?? {};
      return {
        id: m.id,
        name: displayName(m.id),
        reasoning: declared.reasoning ?? guess.reasoning ?? false,
        thinkingLevelMap: declared.thinkingLevelMap ?? guess.thinkingLevelMap,
        input: ["text", "image"] as ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: declared.contextWindow ?? guess.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: declared.maxTokens ?? guess.maxTokens ?? DEFAULT_MAX_TOKENS,
      };
    }),
  });

  console.log(
    `[litellm-sync] Registered ${models.length} model(s): ${models.map((m) => m.id).join(", ")}`
  );
}

// ---------------------------------------------------------------------------
// Extension entry point (async factory — pi awaits before session_start)
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  await syncModels(pi);

  // Re-sync on /reload so the selector stays fresh without restarting pi
  pi.on("session_start", async (event) => {
    if (event.reason === "reload") {
      await syncModels(pi);
    }
  });
}
