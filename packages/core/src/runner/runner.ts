import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ProviderAIClient, type AIClient } from "../ai/client.js";
import type { AgentContext } from "../ai/agents/context.js";
import { BrowserPool, BrowserSession } from "../browser/session.js";
import { FileCacheBackend, TestCache } from "../cache/store.js";
import type { MementoConfig } from "../config.js";
import { parseFile } from "../format/parse.js";
import type { TestFile } from "../format/types.js";
import { KnowledgeBase } from "../knowledge/kb.js";
import { errMsg, StepExecutor, type StepResult } from "./executor.js";
import type { Env } from "./script.js";

export type TestStatus = "passed" | "failed" | "skipped";

export interface TestResult {
  testId: string;
  file: string;
  description?: string;
  status: TestStatus;
  attempt: number;
  startedAt: number;
  durationMs: number;
  error?: string;
  /** Which section failed: setup (before), main steps, or teardown (after). */
  failedIn?: "before" | "steps" | "after";
  before: StepResult[];
  steps: StepResult[];
  after: StepResult[];
  cache: { hits: number; misses: number; healed: number };
  ai: { calls: number; inputTokens: number; outputTokens: number; models: string[] };
  artifactsDir: string;
  trace?: string;
  video?: string;
}

export interface RunSummary {
  runId: string;
  startedAt: number;
  durationMs: number;
  passed: number;
  failed: number;
  skipped: number;
  results: TestResult[];
  outputDir: string;
}

export interface RunOptions {
  /** Files or directories to run. Defaults to the config's include globs. */
  paths?: string[];
  /** Only run tests whose id or file contains this string. */
  grep?: string;
  labels?: string[];
  env?: string;
  parallel?: number;
  disableCache?: boolean;
  headed?: boolean;
  /** Inject an AI client (tests, desktop app). */
  ai?: AIClient;
  /** Extra variables available as `env.X`. */
  variables?: Env;
  signal?: AbortSignal;
}

export interface RunnerEvents {
  "run:start": [{ runId: string; tests: TestFile[] }];
  "test:start": [{ testId: string; file: string; attempt: number }];
  "step:start": [{ testId: string; path: string; label: string }];
  "step:end": [{ testId: string; result: StepResult }];
  "test:end": [TestResult];
  "run:end": [RunSummary];
  log: [{ testId?: string; message: string }];
}

export class Runner extends EventEmitter<RunnerEvents> {
  constructor(readonly cfg: MementoConfig) {
    super();
  }

  /** Find and parse test files. */
  discover(opts: Pick<RunOptions, "paths" | "grep" | "labels"> = {}): TestFile[] {
    const roots = opts.paths?.length ? opts.paths.map((p) => resolve(p)) : [this.cfg.rootDir];
    const files = new Set<string>();
    for (const r of roots) {
      if (statSync(r, { throwIfNoEntry: false })?.isFile()) files.add(r);
      else for (const f of walk(r)) if (matchesAny(relative(this.cfg.rootDir, f), this.cfg.include) && !matchesAny(relative(this.cfg.rootDir, f), this.cfg.exclude)) files.add(f);
    }
    const tests: TestFile[] = [];
    for (const f of [...files].sort()) {
      const parsed = parseFile(f);
      if (parsed.kind !== "test") continue;
      if (opts.grep && !parsed.id.includes(opts.grep) && !f.includes(opts.grep)) continue;
      if (opts.labels?.length && !opts.labels.some((l) => parsed.labels?.includes(l))) continue;
      tests.push(parsed);
    }
    return tests;
  }

  /** Like `discover`, but reports files that fail to parse instead of throwing. */
  discoverWithErrors(): Array<{ id: string; filePath: string; description?: string; labels?: string[]; steps: number; error?: string }> {
    const out: Array<{ id: string; filePath: string; description?: string; labels?: string[]; steps: number; error?: string }> = [];
    for (const f of [...walk(this.cfg.rootDir)].sort()) {
      const rel = relative(this.cfg.rootDir, f);
      if (!matchesAny(rel, this.cfg.include) || matchesAny(rel, this.cfg.exclude)) continue;
      try {
        const t = parseFile(f);
        if (t.kind === "test") out.push({ id: t.id, filePath: f, description: t.description, labels: t.labels, steps: t.steps.length });
      } catch (e) {
        out.push({ id: rel.split("/").pop()!.replace(/\.test\.ya?ml$/, ""), filePath: f, steps: 0, error: (e as Error).message });
      }
    }
    return out;
  }

  async run(opts: RunOptions = {}): Promise<RunSummary> {
    const tests = this.discover(opts);
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const outputDir = resolve(this.cfg.rootDir, this.cfg.outputDir, runId);
    mkdirSync(outputDir, { recursive: true });
    const startedAt = Date.now();
    this.emit("run:start", { runId, tests });

    const browserCfg = { ...this.cfg.browser, headless: opts.headed ? false : this.cfg.browser.headless };
    const pool = new BrowserPool(browserCfg);
    const ai = opts.ai ?? new ProviderAIClient(this.cfg.ai);
    const kb = KnowledgeBase.load(resolve(this.cfg.rootDir, this.cfg.knowledgeDir));
    const environment = this.cfg.environments.find((e) => e.name === opts.env);
    if (opts.env && !environment) throw new Error(`Unknown environment "${opts.env}"`);

    const results: TestResult[] = [];
    const queue = [...tests];
    const workers = Math.max(1, Math.min(opts.parallel ?? this.cfg.parallel, queue.length || 1));
    try {
      await Promise.all(
        Array.from({ length: workers }, async () => {
          for (let t = queue.shift(); t; t = queue.shift()) {
            if (opts.signal?.aborted) break;
            const maxAttempts = (t.retries ?? this.cfg.retries) + 1;
            let r: TestResult | undefined;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
              r = await this.runTest(t, attempt, { pool, ai, kb, outputDir, environment, opts, browserCfg });
              if (r.status !== "failed") break;
            }
            results.push(r!);
          }
        }),
      );
    } finally {
      await pool.close();
    }

    const summary: RunSummary = {
      runId,
      startedAt,
      durationMs: Date.now() - startedAt,
      passed: results.filter((r) => r.status === "passed").length,
      failed: results.filter((r) => r.status === "failed").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      results,
      outputDir,
    };
    writeFileSync(join(outputDir, "summary.json"), JSON.stringify(summary, null, 2));
    this.emit("run:end", summary);
    return summary;
  }

  private async runTest(
    test: TestFile,
    attempt: number,
    s: {
      pool: BrowserPool;
      ai: AIClient;
      kb: KnowledgeBase;
      outputDir: string;
      environment?: MementoConfig["environments"][number];
      opts: RunOptions;
      browserCfg: MementoConfig["browser"];
    },
  ): Promise<TestResult> {
    const artifactsDir = join(s.outputDir, `${test.id}${attempt > 1 ? `-retry${attempt - 1}` : ""}`);
    mkdirSync(artifactsDir, { recursive: true });
    const result: TestResult = {
      testId: test.id,
      file: relative(this.cfg.rootDir, test.filePath),
      description: test.description,
      status: "passed",
      attempt,
      startedAt: Date.now(),
      durationMs: 0,
      before: [],
      steps: [],
      after: [],
      cache: { hits: 0, misses: 0, healed: 0 },
      ai: { calls: 0, inputTokens: 0, outputTokens: 0, models: [] },
      artifactsDir,
    };
    if (test.disabled) {
      result.status = "skipped";
      this.emit("test:end", result);
      return result;
    }
    this.emit("test:start", { testId: test.id, file: result.file, attempt });

    const cacheCfg = this.cfg.cache;
    const cache = new TestCache(
      cacheCfg.enabled && !s.opts.disableCache ? new FileCacheBackend(resolve(this.cfg.rootDir, cacheCfg.dir)) : null,
      test.id,
      cacheCfg.ttlDays * 86400_000,
    );
    const videoDir = this.cfg.video !== "off" ? join(artifactsDir, "video") : undefined;
    const session = await BrowserSession.create(s.pool, s.browserCfg, { recordVideoDir: videoDir });
    const tracing = this.cfg.trace !== "off";
    if (tracing) await session.context.tracing.start({ screenshots: true, snapshots: true, sources: false });

    const baseUrl = s.environment?.baseUrl ?? this.cfg.baseUrl;
    const env: Env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(k) || k.startsWith("TEST_") || k.startsWith("QA_"))),
      ...(s.environment?.variables ?? {}),
      ...(s.opts.variables ?? {}),
      BASE_URL: baseUrl,
      TEST_ID: test.id,
    };

    const ctx: AgentContext = {
      ai: s.ai,
      session,
      cache,
      kb: s.kb,
      testId: test.id,
      vision: this.cfg.ai.vision,
      abortSignal: s.opts.signal,
      log: (message) => this.emit("log", { testId: test.id, message }),
    };
    const exec = new StepExecutor(ctx, this.cfg, env, {
      artifactsDir,
      baseUrl,
      screenshots: true,
      events: {
        onStepStart: (path, label) => this.emit("step:start", { testId: test.id, path, label }),
        onStepEnd: (r) => this.emit("step:end", { testId: test.id, result: r }),
      },
    });

    const fileDir = dirname(test.filePath);
    const timeout = setTimeout(() => void session.close(), this.cfg.testTimeoutMs);
    try {
      const start = test.url ? test.url : baseUrl;
      if (start) {
        const url = /^[a-z]+:/i.test(start) ? start : new URL(start, baseUrl).toString();
        await session.page.goto(url, { waitUntil: "domcontentloaded" });
        await session.settle();
      }
      result.before = await exec.runSteps(test.before, "before", fileDir);
      if (failed(result.before)) {
        result.failedIn = "before";
      } else {
        result.steps = await exec.runSteps(test.steps, "steps", fileDir);
        if (failed(result.steps)) result.failedIn = "steps";
      }
    } catch (err) {
      result.error = errMsg(err);
      result.failedIn ??= "steps";
    } finally {
      // Teardown always runs.
      try {
        result.after = await exec.runSteps(test.after, "after", fileDir);
        if (failed(result.after) && !result.failedIn) result.failedIn = "after";
      } catch (err) {
        result.error ??= errMsg(err);
      }
      clearTimeout(timeout);
    }

    const all = [...result.before, ...result.steps, ...result.after];
    const firstFail = flatten(all).find((r) => r.status === "failed");
    if (result.failedIn || result.error || exec.softFailures > 0) result.status = "failed";
    result.error ??= firstFail?.error ?? (exec.softFailures ? `${exec.softFailures} soft assertion(s) failed` : undefined);

    // Child steps' model calls are bubbled into their parents; count top-level only.
    dedupeAI(result, all);
    result.cache = { ...cache.stats };

    if (tracing) {
      const keep = this.cfg.trace === "on" || result.status === "failed";
      const tracePath = join(artifactsDir, "trace.zip");
      await session.context.tracing.stop(keep ? { path: tracePath } : undefined).catch(() => {});
      if (keep) result.trace = tracePath;
    }
    const video = session.page.video();
    await session.close();
    if (video) {
      const keep = this.cfg.video === "on" || result.status === "failed";
      if (keep) result.video = await video.path().catch(() => undefined);
      else rmSync(videoDir!, { recursive: true, force: true });
    }

    // Cache entries are only trustworthy if the run that produced them passed.
    if (result.status === "passed" || !this.cfg.cache.saveOnlyOnPass) cache.commit();

    result.durationMs = Date.now() - result.startedAt;
    writeFileSync(join(artifactsDir, "result.json"), JSON.stringify(result, null, 2));
    this.emit("test:end", result);
    return result;
  }
}

function failed(rs: StepResult[]) {
  return rs.some((r) => r.status === "failed");
}

export function flatten(rs: StepResult[]): StepResult[] {
  return rs.flatMap((r) => [r, ...flatten(r.children ?? [])]);
}

/** Model calls are bubbled to parent steps; count each call once (top-level steps only). */
function dedupeAI(result: TestResult, top: StepResult[]) {
  const calls = top.flatMap((s) => s.ai);
  result.ai.calls = calls.length;
  result.ai.inputTokens = calls.reduce((n, c) => n + c.inputTokens, 0);
  result.ai.outputTokens = calls.reduce((n, c) => n + c.outputTokens, 0);
  result.ai.models = [...new Set(calls.map((c) => c.model))];
}

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    const st = statSync(p, { throwIfNoEntry: false });
    if (st?.isDirectory()) yield* walk(p);
    else if (st?.isFile()) yield p;
  }
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(rel: string, globs: string[]) {
  const p = rel.split("\\").join("/");
  return globs.some((g) => globToRegExp(g).test(p));
}
