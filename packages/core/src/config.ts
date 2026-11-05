import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * `memento.config.yaml` — project configuration.
 *
 * The important part for an open-source tool is `ai`: users bring their own
 * providers and pick a model per agent. Values may reference environment
 * variables with `${VAR}` so keys never need to be committed.
 */

const ProviderSchema = z.object({
  /**
   * - anthropic / openai / google: first-party SDKs
   * - openai-compatible: anything that speaks the OpenAI chat API — Ollama,
   *   LM Studio, vLLM, OpenRouter, Groq, Together, xAI, Mistral, Azure, ...
   */
  type: z.enum(["anthropic", "openai", "google", "openai-compatible"]),
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** Whether this provider's models accept images. Default true. Set false for text-only local models. */
  vision: z.boolean().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderSchema>;

/** A model reference is `provider:model-id`, or a list of them to fall back through. */
const ModelRef = z.union([z.string(), z.array(z.string()).min(1)]);

export const AGENTS = ["locator", "assertion", "extract", "act", "recovery", "review", "author"] as const;
export type AgentName = (typeof AGENTS)[number];

const AiSchema = z.object({
  providers: z.record(z.string(), ProviderSchema).prefault({}),
  models: z
    .object({
      default: ModelRef.optional(),
      locator: ModelRef.optional(),
      assertion: ModelRef.optional(),
      extract: ModelRef.optional(),
      act: ModelRef.optional(),
      recovery: ModelRef.optional(),
      review: ModelRef.optional(),
      author: ModelRef.optional(),
    })
    .prefault({}),
  /** Send screenshots to models. Turn off for text-only models or to reduce cost. */
  vision: z.boolean().default(true),
  /** Try to recover transient failures (cookie banners, stray modals) before failing a step. */
  failureRecovery: z.boolean().default(false),
  temperature: z.number().default(0),
  /** Upper bound on actions an AI action (`act`) may take. */
  actMaxSteps: z.number().default(25),
});

const BrowserSchema = z.object({
  /** Memento drives real Playwright browsers, so all three engines work. */
  type: z.enum(["chromium", "firefox", "webkit"]).default("chromium"),
  headless: z.boolean().default(true),
  viewport: z.object({ width: z.number(), height: z.number() }).default({ width: 1280, height: 800 }),
  /** Max wait for the page / element to settle before an interaction. */
  smartWaitingTimeoutMs: z.number().default(5000),
  pageLoadTimeoutMs: z.number().default(15000),
  elementCheckTimeoutMs: z.number().default(5000),
  typeDelayMs: z.number().default(10),
  slowMoMs: z.number().default(0),
  timezone: z.string().optional(),
  locale: z.string().optional(),
  userAgent: z.string().optional(),
  /** Extra HTML attributes to keep in the page snapshot sent to the AI. */
  importantAttributes: z.array(z.string()).default([]),
  /** Attributes to strip from the snapshot (e.g. framework-generated noise). */
  bannedAttributes: z.array(z.string()).default([]),
  snapshotMaxChars: z.number().default(30000),
  executablePath: z.string().optional(),
});

const EnvironmentSchema = z.object({
  name: z.string(),
  baseUrl: z.string().optional(),
  variables: z.record(z.string(), z.unknown()).default({}),
});

export const ConfigSchema = z.object({
  name: z.string().default("memento-project"),
  /** Globs (relative to the config file) for test files. */
  include: z.array(z.string()).default(["**/*.test.yaml"]),
  exclude: z.array(z.string()).default(["**/node_modules/**"]),
  baseUrl: z.string().optional(),
  environments: z.array(EnvironmentSchema).default([]),
  parallel: z.number().default(1),
  retries: z.number().default(0),
  testTimeoutMs: z.number().default(10 * 60 * 1000),
  outputDir: z.string().default("memento-results"),
  /** Record a Playwright trace per test (open with `npx playwright show-trace`). */
  trace: z.enum(["on", "off", "retain-on-failure"]).default("retain-on-failure"),
  video: z.enum(["on", "off", "retain-on-failure"]).default("off"),
  /** `local` stores the step cache in `.memento/cache` next to the config. */
  cache: z
    .object({
      enabled: z.boolean().default(true),
      dir: z.string().default(".memento/cache"),
      /** Only persist cache entries from passing runs. */
      saveOnlyOnPass: z.boolean().default(true),
      ttlDays: z.number().default(30),
    })
    .prefault({}),
  knowledgeDir: z.string().default(".memento/knowledge"),
  ai: AiSchema.prefault({}),
  browser: BrowserSchema.prefault({}),
});

export type MementoConfig = z.infer<typeof ConfigSchema> & { rootDir: string; configPath?: string };

export const CONFIG_FILENAMES = ["memento.config.yaml", "memento.config.yml"];

export function findConfig(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    for (const f of CONFIG_FILENAMES) {
      const p = join(dir, f);
      if (existsSync(p)) return p;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Replace `${VAR}` / `${VAR:-default}` with environment variables, recursively. */
export function expandEnv<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, def?: string) => env[name] ?? def ?? "") as T;
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, env)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v, env)])) as T;
  }
  return value;
}

export function loadConfig(pathOrDir?: string, overrides: Partial<z.input<typeof ConfigSchema>> = {}): MementoConfig {
  let configPath: string | undefined;
  if (pathOrDir && existsSync(pathOrDir) && pathOrDir.match(/\.ya?ml$/)) configPath = resolve(pathOrDir);
  else configPath = findConfig(pathOrDir ?? process.cwd());

  let raw: Record<string, unknown> = {};
  if (configPath) {
    raw = (parseYaml(readFileSync(configPath, "utf8")) as Record<string, unknown>) ?? {};
  }
  const merged = deepMerge(raw, overrides as Record<string, unknown>);
  const parsed = ConfigSchema.parse(expandEnv(merged));
  applyEnvShortcuts(parsed);
  return { ...parsed, rootDir: configPath ? dirname(configPath) : resolve(pathOrDir ?? process.cwd()), configPath };
}

/**
 * Zero-config convenience: if no providers are configured, pick them up from
 * well-known environment variables so `ANTHROPIC_API_KEY=... memento run` works.
 */
function applyEnvShortcuts(cfg: z.infer<typeof ConfigSchema>): void {
  const p = cfg.ai.providers;
  const e = process.env;
  if (Object.keys(p).length === 0) {
    if (e.ANTHROPIC_API_KEY) p.anthropic = { type: "anthropic", apiKey: e.ANTHROPIC_API_KEY };
    if (e.OPENAI_API_KEY) p.openai = { type: "openai", apiKey: e.OPENAI_API_KEY };
    if (e.GOOGLE_GENERATIVE_AI_API_KEY) p.google = { type: "google", apiKey: e.GOOGLE_GENERATIVE_AI_API_KEY };
    if (e.OPENROUTER_API_KEY) p.openrouter = { type: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", apiKey: e.OPENROUTER_API_KEY };
    if (e.OLLAMA_BASE_URL) p.ollama = { type: "openai-compatible", baseURL: e.OLLAMA_BASE_URL, vision: false };
  }
  if (e.MEMENTO_MODEL) cfg.ai.models.default = e.MEMENTO_MODEL;
  if (!cfg.ai.models.default) {
    if (p.anthropic) cfg.ai.models.default = "anthropic:claude-sonnet-5-5";
    else if (p.openai) cfg.ai.models.default = "openai:gpt-5";
    else if (p.google) cfg.ai.models.default = "google:gemini-2.5-pro";
  }
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    const prev = out[k];
    if (prev && typeof prev === "object" && !Array.isArray(prev) && v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>);
    } else out[k] = v;
  }
  return out;
}
