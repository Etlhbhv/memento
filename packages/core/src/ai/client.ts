import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, Output, type LanguageModel, type ModelMessage } from "ai";
import type { z } from "zod";
import type { AgentName, MementoConfig, ProviderConfig } from "../config.js";

/**
 * The AI "sublayer".
 *
 * Every agent talks to models through this one small interface, so the rest of
 * Memento never knows which vendor is behind it. The default implementation
 * uses the Vercel AI SDK (the same foundation Momentic moved to), which gives
 * us Anthropic, OpenAI, Google and any OpenAI-compatible endpoint (Ollama,
 * LM Studio, vLLM, OpenRouter, Groq, ...) behind one API.
 *
 * Agents only ever ask for *structured output* (JSON matching a zod schema),
 * never provider-specific tool calling. That keeps small local models usable.
 */
export interface AIRequest<T> {
  agent: AgentName;
  system: string;
  /** Text blocks and images, in order. */
  content: Array<{ type: "text"; text: string } | { type: "image"; data: Uint8Array; mediaType?: string }>;
  schema: z.ZodType<T>;
  /** Earlier turns, for multi-turn agents such as `act`. */
  history?: ModelMessage[];
  abortSignal?: AbortSignal;
}

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AIResponse<T> {
  object: T;
  model: string;
  usage: AIUsage;
  durationMs: number;
}

export interface AIClient {
  generate<T>(req: AIRequest<T>): Promise<AIResponse<T>>;
  /** Whether screenshots should be sent for this agent. */
  supportsVision(agent: AgentName): boolean;
  /** Human-readable model name for an agent (for logs/results). */
  modelFor(agent: AgentName): string;
}

export class AINotConfiguredError extends Error {
  constructor(agent: string) {
    super(
      `No AI model configured for the "${agent}" agent. Add one to memento.config.yaml:\n\n` +
        `ai:\n  providers:\n    anthropic: { type: anthropic, apiKey: \${ANTHROPIC_API_KEY} }\n  models:\n    default: anthropic:claude-sonnet-5-5\n\n` +
        `or set ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / OPENROUTER_API_KEY / OLLAMA_BASE_URL.`,
    );
    this.name = "AINotConfiguredError";
  }
}

type ResolvedModel = { ref: string; model: LanguageModel; vision: boolean };

export class ProviderAIClient implements AIClient {
  private cache = new Map<string, ResolvedModel>();

  constructor(private readonly cfg: MementoConfig["ai"]) {}

  modelFor(agent: AgentName): string {
    return this.refs(agent).join(" → ") || "(none)";
  }

  supportsVision(agent: AgentName): boolean {
    if (!this.cfg.vision) return false;
    const first = this.refs(agent)[0];
    if (!first) return false;
    return this.resolve(first).vision;
  }

  private refs(agent: AgentName): string[] {
    const m = this.cfg.models[agent] ?? this.cfg.models.default;
    if (!m) return [];
    return Array.isArray(m) ? m : [m];
  }

  private resolve(ref: string): ResolvedModel {
    const hit = this.cache.get(ref);
    if (hit) return hit;
    const idx = ref.indexOf(":");
    if (idx < 0) throw new Error(`Model reference "${ref}" must look like "provider:model-id"`);
    const providerName = ref.slice(0, idx);
    const modelId = ref.slice(idx + 1);
    const p = this.cfg.providers[providerName];
    if (!p) {
      throw new Error(`Model "${ref}" uses provider "${providerName}", which is not defined under ai.providers`);
    }
    const resolved = { ref, model: createModel(providerName, p, modelId), vision: p.vision ?? true };
    this.cache.set(ref, resolved);
    return resolved;
  }

  async generate<T>(req: AIRequest<T>): Promise<AIResponse<T>> {
    const refs = this.refs(req.agent);
    if (refs.length === 0) throw new AINotConfiguredError(req.agent);
    let lastErr: unknown;
    // Fallback chain: try each configured model in order.
    for (const ref of refs) {
      const m = this.resolve(ref);
      const started = Date.now();
      const content = req.content
        .filter((c) => c.type === "text" || (m.vision && this.cfg.vision))
        .map((c) =>
          c.type === "text"
            ? { type: "text" as const, text: c.text }
            : { type: "file" as const, data: c.data, mediaType: c.mediaType ?? "image/png" },
        );
      const messages: ModelMessage[] = [...(req.history ?? []), { role: "user", content }];
      try {
        const res = await generateText({
          model: m.model,
          instructions: req.system,
          messages,
          temperature: this.cfg.temperature,
          output: Output.object({ schema: req.schema }),
          maxRetries: 2,
          abortSignal: req.abortSignal,
        });
        return {
          object: res.output as T,
          model: ref,
          usage: { inputTokens: res.usage.inputTokens ?? 0, outputTokens: res.usage.outputTokens ?? 0 },
          durationMs: Date.now() - started,
        };
      } catch (err) {
        // Some OpenAI-compatible servers ignore structured-output requests and
        // reply with prose around the JSON. Try to salvage it.
        const salvaged = salvageJson(err, req.schema);
        if (salvaged !== undefined) {
          return { object: salvaged, model: ref, usage: { inputTokens: 0, outputTokens: 0 }, durationMs: Date.now() - started };
        }
        lastErr = err;
      }
    }
    throw lastErr;
  }
}

function createModel(name: string, p: ProviderConfig, modelId: string): LanguageModel {
  switch (p.type) {
    case "anthropic":
      return createAnthropic({ apiKey: p.apiKey, baseURL: p.baseURL, headers: p.headers })(modelId);
    case "openai":
      return createOpenAI({ apiKey: p.apiKey, baseURL: p.baseURL, headers: p.headers })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey: p.apiKey, baseURL: p.baseURL, headers: p.headers })(modelId);
    case "openai-compatible":
      if (!p.baseURL) throw new Error(`Provider "${name}" (openai-compatible) needs a baseURL`);
      return createOpenAICompatible({
        name,
        apiKey: p.apiKey,
        baseURL: p.baseURL,
        headers: p.headers,
        supportsStructuredOutputs: true,
      })(modelId);
  }
}

function salvageJson<T>(err: unknown, schema: z.ZodType<T>): T | undefined {
  const text = (err as { text?: string })?.text;
  if (typeof text !== "string") return undefined;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
