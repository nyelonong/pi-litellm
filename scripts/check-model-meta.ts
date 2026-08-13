// Asserts the model-sync helpers against the model ids a real LiteLLM proxy serves.
import { modelsUrl, modelMeta } from "../extensions/litellm-sync.ts";

interface Expected {
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  xhigh?: string | null;
}

const DEFAULT_CONTEXT = 128000;
const DEFAULT_MAX_TOKENS = 16384;

// What ~/.pi/agent/models.json declares. The heuristic must not overwrite these.
const DECLARED: Record<string, Partial<Expected>> = {
  "azure_ai/gpt-5.5": { reasoning: true },
  "azure_ai/gpt-5.6-sol": { reasoning: true, contextWindow: 1050000 },
  "azure_ai/gpt-5.6-terra": { reasoning: true, contextWindow: 1050000 },
  "azure_ai/gpt-5.6-luna": { reasoning: true, contextWindow: 1050000 },
  "azure_ai/deepseek-v4-pro": { reasoning: false, contextWindow: 1048576, maxTokens: 16000 },
  "azure_ai/kimi-k2.6": {},
};

const EXPECTED: Record<string, Expected> = {
  // Claude: 1M context on the current tiers, 200K on Haiku 4.5.
  "anthropic/claude-fable-5": { reasoning: true, contextWindow: 1000000, maxTokens: 128000 },
  "anthropic/claude-opus-4.8": { reasoning: true, contextWindow: 1000000, maxTokens: 128000, xhigh: "xhigh" },
  "anthropic/claude-sonnet-4.6": { reasoning: true, contextWindow: 1000000, maxTokens: 128000, xhigh: "max" },
  "anthropic/claude-haiku-4.5": { reasoning: true, contextWindow: 200000, maxTokens: 64000 },

  // GPT-5.6: reasoning models, 1,050,000 context, 128,000 max output.
  "azure_ai/gpt-5.6-terra": { reasoning: true, contextWindow: 1050000, maxTokens: 128000, xhigh: "xhigh" },
  "azure_ai/gpt-5.6-sol": { reasoning: true, contextWindow: 1050000, maxTokens: 128000, xhigh: "xhigh" },
  "azure_ai/gpt-5.6-luna": { reasoning: true, contextWindow: 1050000, maxTokens: 128000, xhigh: "xhigh" },

  // Reasoning is known for the rest of the GPT-5 line; their windows are not, so
  // models.json decides, and the default stands where it says nothing.
  "azure_ai/gpt-5.5": { reasoning: true, contextWindow: DEFAULT_CONTEXT, maxTokens: DEFAULT_MAX_TOKENS },
  "azure_ai/gpt-5.4-mini": { reasoning: true, contextWindow: DEFAULT_CONTEXT, maxTokens: DEFAULT_MAX_TOKENS },
  "azure_ai/gpt-5.3-codex": { reasoning: true, contextWindow: DEFAULT_CONTEXT, maxTokens: DEFAULT_MAX_TOKENS },

  // Unrecognized families: whatever models.json declares, never a guess.
  "azure_ai/deepseek-v4-pro": { reasoning: false, contextWindow: 1048576, maxTokens: 16000 },
  "azure_ai/deepseek-v4-flash": { reasoning: false, contextWindow: DEFAULT_CONTEXT, maxTokens: DEFAULT_MAX_TOKENS },
  "azure_ai/kimi-k2.6": { reasoning: false, contextWindow: DEFAULT_CONTEXT, maxTokens: DEFAULT_MAX_TOKENS },
};

const URL_CASES: Array<[string, string]> = [
  ["https://llm.cekat.id/v1", "https://llm.cekat.id/v1/models"],
  ["https://llm.cekat.id/v1/", "https://llm.cekat.id/v1/models"],
  ["https://llm.cekat.id", "https://llm.cekat.id/v1/models"],
  ["http://localhost:4000", "http://localhost:4000/v1/models"],
];

const failures: string[] = [];

for (const [baseUrl, want] of URL_CASES) {
  const got = modelsUrl(baseUrl);
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${baseUrl.padEnd(28)} -> ${got}`);
  if (!ok) failures.push(`${baseUrl}: want ${want}, got ${got}`);
}

console.log("");

// Mirrors what the sync does: the heuristic supplies what it knows, models.json
// overrides it, and the defaults fill whatever neither declares.
function resolve(id: string) {
  const guess = modelMeta(id) ?? {};
  const declared = DECLARED[id] ?? {};
  return {
    reasoning: declared.reasoning ?? guess.reasoning ?? false,
    contextWindow: declared.contextWindow ?? guess.contextWindow ?? DEFAULT_CONTEXT,
    maxTokens: declared.maxTokens ?? guess.maxTokens ?? DEFAULT_MAX_TOKENS,
    xhigh: guess.thinkingLevelMap ? guess.thinkingLevelMap.xhigh : undefined,
  };
}

for (const [id, want] of Object.entries(EXPECTED)) {
  const got = resolve(id);
  const bad: string[] = [];
  if (got.reasoning !== want.reasoning) bad.push(`reasoning want ${want.reasoning} got ${got.reasoning}`);
  if (got.contextWindow !== want.contextWindow) bad.push(`ctx want ${want.contextWindow} got ${got.contextWindow}`);
  if (got.maxTokens !== want.maxTokens) bad.push(`max want ${want.maxTokens} got ${got.maxTokens}`);
  if (want.xhigh !== undefined && got.xhigh !== want.xhigh) bad.push(`xhigh want ${want.xhigh} got ${got.xhigh}`);

  console.log(
    `${bad.length ? "FAIL" : "PASS"}  ${id.padEnd(28)} reasoning=${String(got.reasoning).padEnd(5)} ctx=${String(got.contextWindow).padEnd(8)} max=${got.maxTokens}`
  );
  if (bad.length) failures.push(`${id}: ${bad.join("; ")}`);
}

console.log("");
if (failures.length) {
  console.error(`${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("all checks passed");
