import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Locator } from "playwright";
import { runAct, type ActHost } from "../ai/agents/act.js";
import { checkAssertion } from "../ai/agents/assertion.js";
import type { AgentContext, AICallRecord } from "../ai/agents/context.js";
import { extract } from "../ai/agents/extract.js";
import { locate } from "../ai/agents/locator.js";
import { tryRecover } from "../ai/agents/recovery.js";
import { sleep } from "../browser/session.js";
import { cacheKey } from "../cache/store.js";
import type { MementoConfig } from "../config.js";
import { describeStep, parseFile, parseStep } from "../format/parse.js";
import type { ModuleFile, Step, Target } from "../format/types.js";
import { evalExpression, interpolate, runNodeScript, type Env } from "./script.js";

export type StepStatus = "passed" | "failed" | "skipped" | "softFailed";

export interface StepResult {
  path: string;
  label: string;
  cmd: string;
  status: StepStatus;
  startedAt: number;
  durationMs: number;
  error?: string;
  /** How the target was found: cache hit, AI, or AI after a stale cache entry. */
  resolution?: "cache" | "ai" | "healed";
  reasoning?: string;
  value?: unknown;
  ai: AICallRecord[];
  screenshot?: string;
  recovered?: boolean;
  children?: StepResult[];
}

export interface ExecutorEvents {
  onStepStart?(path: string, label: string): void;
  onStepEnd?(result: StepResult): void;
}

export class StepFailure extends Error {
  constructor(message: string, readonly soft = false) {
    super(message);
    this.name = "StepFailure";
  }
}

/** Runs steps for one test against one browser session. */
export class StepExecutor {
  private recoveries = 0;
  private mocks = new Map<string, string>();
  private extraHeaders: Record<string, string> = {};
  private currentAICalls: AICallRecord[] | null = null;
  softFailures = 0;

  constructor(
    private readonly ctx: AgentContext,
    private readonly cfg: MementoConfig,
    readonly env: Env,
    private readonly opts: { artifactsDir: string; baseUrl?: string; events?: ExecutorEvents; screenshots: boolean },
  ) {
    ctx.onAICall = (r) => this.currentAICalls?.push(r);
  }

  async runSteps(steps: Step[], prefix: string, fileDir: string): Promise<StepResult[]> {
    const results: StepResult[] = [];
    for (let i = 0; i < steps.length; i++) {
      const r = await this.runStep(steps[i], `${prefix}[${i}]`, fileDir);
      results.push(r);
      if (r.status === "failed") break;
      if (this.cfg.browser.slowMoMs && i < steps.length - 1) await sleep(this.cfg.browser.slowMoMs);
    }
    return results;
  }

  async runStep(step: Step, path: string, fileDir: string): Promise<StepResult> {
    const label = safeLabel(step, this.env);
    const result: StepResult = { path, label, cmd: step.cmd, status: "passed", startedAt: Date.now(), durationMs: 0, ai: [] };
    this.opts.events?.onStepStart?.(path, label);
    if (step.skipped) {
      result.status = "skipped";
      return this.finish(result);
    }
    const parentCalls = this.currentAICalls;
    this.currentAICalls = result.ai;
    try {
      const attempts = (step.retries ?? 0) + 1;
      for (let attempt = 1; ; attempt++) {
        try {
          const value = await this.execute(step, path, fileDir, result);
          if (value !== undefined) {
            result.value = value;
            if (step.saveAs) this.env[step.saveAs] = value;
          }
          break;
        } catch (err) {
          if (attempt < attempts) {
            await this.ctx.session.settle(1000);
            continue;
          }
          // Transient failure recovery for interactive preset steps.
          if (this.canRecover(step) && !(err instanceof StepFailure && err.soft)) {
            this.recoveries++;
            const rec = await tryRecover(this.ctx, this.host(fileDir), label, errMsg(err)).catch(() => ({ recovered: false, reasoning: "" }));
            if (rec.recovered) {
              try {
                const value = await this.execute(step, path, fileDir, result);
                if (value !== undefined && step.saveAs) this.env[step.saveAs] = value;
                result.recovered = true;
                break;
              } catch (err2) {
                err = err2;
              }
            }
          }
          throw err;
        }
      }
    } catch (err) {
      result.error = errMsg(err);
      const soft = step.soft || (err instanceof StepFailure && err.soft);
      result.status = soft ? "softFailed" : "failed";
      if (soft) this.softFailures++;
      if (this.opts.screenshots) result.screenshot = await this.capture(path).catch(() => undefined);
    } finally {
      this.currentAICalls = parentCalls;
      // Bubble model calls up so the parent step (e.g. a module) shows the total.
      if (parentCalls) parentCalls.push(...result.ai);
    }
    return this.finish(result);
  }

  private finish(r: StepResult): StepResult {
    r.durationMs = Date.now() - r.startedAt;
    this.opts.events?.onStepEnd?.(r);
    return r;
  }

  private canRecover(step: Step): boolean {
    return (
      this.cfg.ai.failureRecovery &&
      this.recoveries < 3 &&
      ["click", "hover", "type", "fill", "select", "focus", "dragAndDrop", "checkElement"].includes(step.cmd)
    );
  }

  private async capture(path: string): Promise<string> {
    const dir = join(this.opts.artifactsDir, "screenshots");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${path.replace(/[^a-zA-Z0-9]+/g, "_")}.jpg`);
    writeFileSync(file, await this.ctx.session.screenshot());
    return file;
  }

  /** Host interface used by the AI action agent to run concrete steps. */
  private host(fileDir: string): ActHost {
    return {
      exec: async (raw, key, pinned) => {
        try {
          const step = parseStep(raw, "ai-step");
          await this.execute(step, key, fileDir, undefined, { cacheKeyOverride: key, pinnedElementId: pinned });
          return { ok: true };
        } catch (err) {
          return { ok: false, error: errMsg(err) };
        }
      },
    };
  }

  // ---------------------------------------------------------------------------

  private get page() {
    return this.ctx.session.page;
  }

  private str(s: string): string {
    return interpolate(s, this.env);
  }

  /**
   * Resolve a step target to a Playwright locator (or coordinates).
   * Natural-language targets go through the cache-first AI locator.
   */
  private async target(
    t: Target,
    key: string,
    step: Step,
    result: StepResult | undefined,
    pinnedElementId?: number,
  ): Promise<{ locator?: Locator; x?: number; y?: number }> {
    switch (t.kind) {
      case "css":
        return { locator: this.page.locator(this.str(t.selector)).first() };
      case "xpath":
        return { locator: this.page.locator(`xpath=${this.str(t.selector)}`).first() };
      case "coords":
        return { x: t.x, y: t.y };
      case "description": {
        const description = this.str(t.description);
        const k = cacheKey(this.ctx.testId, key, step.cmd, description);
        if (pinnedElementId !== undefined) {
          const fp = await this.ctx.session.fingerprint(pinnedElementId);
          if (fp) {
            if (key && this.ctx.cache.enabled && step.cache !== false) {
              this.ctx.cache.set(k, {
                kind: "locator",
                description,
                fingerprint: fp,
                signals: { text: !!(fp.name || fp.text), role: true, attributes: [], visual: false, position: false },
                savedAt: Date.now(),
              });
            }
            return { locator: this.page.locator(fp.selector).first() };
          }
        }
        const r = await locate(this.ctx, description, k, { useCache: step.cache !== false && !!key, timeoutMs: step.timeout });
        if (result) {
          result.resolution = r.healed ? "healed" : r.source;
          result.reasoning = r.reasoning;
        }
        return { locator: this.page.locator(r.fingerprint.selector).first() };
      }
    }
  }

  private async execute(
    step: Step,
    path: string,
    fileDir: string,
    result: StepResult | undefined,
    o: { cacheKeyOverride?: string; pinnedElementId?: number } = {},
  ): Promise<unknown> {
    const key = o.cacheKeyOverride ?? path;
    const timeout = step.timeout ?? this.cfg.browser.smartWaitingTimeoutMs;
    const T = (t: Target) => this.target(t, key, step, result, o.pinnedElementId);
    const page = this.page;

    switch (step.cmd) {
      // ---------------------------------------------------------------- AI
      case "act": {
        const r = await runAct(this.ctx, this.host(fileDir), {
          goal: this.str(step.goal),
          precondition: step.precondition && this.str(step.precondition),
          postcondition: step.postcondition && this.str(step.postcondition),
          useCache: step.cache !== false,
          stepKey: key,
          maxSteps: step.maxSteps ?? this.cfg.ai.actMaxSteps,
        });
        if (result) {
          result.resolution = r.source;
          result.reasoning = r.message;
          result.children = r.trajectory.map((s, i) => ({
            path: `${path}.ai[${i}]`,
            label: safeLabel(parseStep(s, "ai-step"), this.env),
            cmd: Object.keys(s)[0],
            status: "passed" as const,
            startedAt: 0,
            durationMs: 0,
            ai: [],
          }));
        }
        return undefined;
      }
      case "assert": {
        const that = this.str(step.that);
        const r = await checkAssertion(this.ctx, that, { visual: step.visual, timeoutMs: step.timeout });
        if (result) result.reasoning = r.reasoning;
        if (!r.passed) throw new StepFailure(`Assertion failed: ${that}\n${r.reasoning}`, step.soft);
        return undefined;
      }
      case "extract":
        return extract(this.ctx, this.str(step.goal), step.schema);

      // ------------------------------------------------------------- Mouse
      case "click": {
        await this.ctx.session.settle();
        const t = await T(step.target);
        if (t.locator) {
          await t.locator.click({ button: step.button, clickCount: step.clickCount, timeout });
        } else {
          await page.mouse.click(t.x!, t.y!, { button: step.button, clickCount: step.clickCount });
        }
        return undefined;
      }
      case "hover": {
        const t = await T(step.target);
        if (t.locator) await t.locator.hover({ timeout });
        else await page.mouse.move(t.x!, t.y!);
        return undefined;
      }
      case "focus": {
        const t = await T(step.target);
        await t.locator?.focus({ timeout });
        return undefined;
      }
      case "blur": {
        if (step.target) {
          const t = await T(step.target);
          await t.locator?.blur({ timeout });
        } else await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        return undefined;
      }
      case "dragAndDrop": {
        const from = await this.target(step.from, `${key}.from`, step, result);
        const to = await this.target(step.to, `${key}.to`, step, result);
        if (from.locator && to.locator) await from.locator.dragTo(to.locator, { timeout });
        else {
          const a = from.locator ? await center(from.locator) : { x: from.x!, y: from.y! };
          const b = to.locator ? await center(to.locator) : { x: to.x!, y: to.y! };
          await page.mouse.move(a.x, a.y);
          await page.mouse.down();
          await page.mouse.move(b.x, b.y, { steps: 10 });
          await page.mouse.up();
        }
        return undefined;
      }

      // ---------------------------------------------------------- Keyboard
      case "type":
      case "fill": {
        await this.ctx.session.settle();
        const text = this.str(step.text);
        const loc = step.target ? (await T(step.target)).locator : undefined;
        if (step.cmd === "fill") {
          if (loc) await loc.fill(text, { timeout });
          else await page.keyboard.insertText(text);
          return undefined;
        }
        if (loc) {
          if (step.clear !== false) await loc.fill("", { timeout });
          else await loc.click({ timeout });
          await loc.pressSequentially(text, { delay: step.delay ?? this.cfg.browser.typeDelayMs, timeout: Math.max(timeout, text.length * 100) });
        } else {
          await page.keyboard.type(text, { delay: step.delay ?? this.cfg.browser.typeDelayMs });
        }
        if (step.pressEnter) await page.keyboard.press("Enter");
        return undefined;
      }
      case "press":
        for (const combo of this.str(step.keys).split(/\s+/).filter(Boolean)) await page.keyboard.press(combo);
        return undefined;
      case "select": {
        const t = await T(step.target);
        const option = this.str(step.option);
        await t.locator!.selectOption([{ label: option }], { timeout }).catch(() => t.locator!.selectOption(option, { timeout }));
        return undefined;
      }
      case "fileUpload": {
        const file = resolveFrom(fileDir, this.str(step.path));
        if (step.target) {
          const t = await T(step.target);
          const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout }), t.locator!.click({ timeout })]);
          await chooser.setFiles(file);
        } else {
          page.once("filechooser", (c) => void c.setFiles(file));
        }
        return undefined;
      }

      // ------------------------------------------------------------ Scroll
      case "scroll": {
        const amount = step.amount ?? Math.round(this.cfg.browser.viewport.height * 0.8);
        const dx = step.direction === "left" ? -amount : step.direction === "right" ? amount : 0;
        const dy = step.direction === "up" ? -amount : step.direction === "down" ? amount : 0;
        if (step.target) {
          const t = await T(step.target);
          await t.locator!.evaluate((el, d) => el.scrollBy(d.dx, d.dy), { dx, dy });
        } else await page.mouse.wheel(dx, dy);
        await sleep(300);
        return undefined;
      }

      // -------------------------------------------------------- Navigation
      case "navigate":
        await page.goto(this.url(this.str(step.url)), { waitUntil: "domcontentloaded" });
        await this.ctx.session.settle();
        return undefined;
      case "refresh":
        await page.reload({ waitUntil: "domcontentloaded" });
        return undefined;
      case "goBack":
        await page.goBack({ waitUntil: "domcontentloaded" });
        return undefined;
      case "goForward":
        await page.goForward({ waitUntil: "domcontentloaded" });
        return undefined;
      case "newTab": {
        const p = await this.ctx.session.context.newPage();
        await p.goto(this.url(this.str(step.url)), { waitUntil: "domcontentloaded" });
        this.ctx.session.page = p;
        return undefined;
      }
      case "switchTab": {
        const deadline = Date.now() + timeout;
        for (;;) {
          const pages = this.ctx.session.pages();
          const match =
            step.index !== undefined ? pages[step.index] : pages.find((p) => step.url && p.url().includes(this.str(step.url)));
          if (match) {
            this.ctx.session.page = match;
            await match.bringToFront();
            return undefined;
          }
          if (Date.now() > deadline) throw new StepFailure(`No tab matching ${step.index ?? step.url}`);
          await sleep(200);
        }
      }
      case "closeTab":
        await page.close();
        return undefined;

      // ------------------------------------------------------------- Waits
      case "wait":
        await sleep(step.ms);
        return undefined;
      case "waitForUrl": {
        const want = this.str(step.url);
        const matches = (u: string) =>
          step.match === "regex" ? new RegExp(want).test(u) : step.match === "glob" ? globToRegex(want).test(u) : u.includes(want);
        const deadline = Date.now() + (step.timeout ?? this.cfg.browser.pageLoadTimeoutMs);
        while (matches(page.url()) === !!step.negate) {
          if (Date.now() > deadline) throw new StepFailure(`URL ${page.url()} ${step.negate ? "still matches" : "does not match"} ${want}`);
          await sleep(200);
        }
        return undefined;
      }

      // ------------------------------------------------------------ Checks
      case "checkPageContains": {
        const want = this.str(step.text);
        const deadline = Date.now() + (step.timeout ?? this.cfg.browser.elementCheckTimeoutMs);
        for (;;) {
          const has = (await this.ctx.session.pageText()).includes(want) || (await page.content()).includes(want);
          if (has !== !!step.negate) return undefined;
          if (Date.now() > deadline) throw new StepFailure(`Page ${step.negate ? "contains" : "does not contain"} "${want}"`, step.soft);
          await sleep(250);
        }
      }
      case "checkElement":
        return this.checkElement(step, key, result, T);
      case "checkElementContent": {
        const t = await T(step.target);
        const want = this.str(step.value);
        await this.poll(step, async () => {
          const text = ((await t.locator!.innerText({ timeout: 1000 }).catch(() => "")) || (await t.locator!.inputValue({ timeout: 500 }).catch(() => ""))).trim();
          const ok = step.mode === "equals" ? text === want : step.mode === "regex" ? new RegExp(want).test(text) : text.includes(want);
          return ok !== !!step.negate ? null : `Element text is "${text.slice(0, 200)}", expected it to ${step.negate ? "not " : ""}${step.mode ?? "contain"} "${want}"`;
        });
        return undefined;
      }
      case "checkElementAttribute": {
        const t = await T(step.target);
        await this.poll(step, async () => {
          const v = await t.locator!.getAttribute(step.attribute, { timeout: 1000 });
          const ok = step.value === undefined ? v !== null : v === this.str(step.value);
          return ok !== !!step.negate ? null : `Attribute ${step.attribute} is ${JSON.stringify(v)}`;
        });
        return undefined;
      }

      // ----------------------------------------------------------- Network
      case "request": {
        const res = await page.request.fetch(this.url(this.str(step.url)), {
          method: step.method ?? "GET",
          headers: step.headers,
          data: typeof step.body === "string" ? this.str(step.body) : step.body,
        });
        const text = await res.text();
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {}
        return { status: res.status(), headers: res.headers(), body };
      }
      case "mock": {
        const pattern = this.str(step.url);
        const k = step.key ?? pattern;
        if (this.mocks.has(k)) await this.ctx.session.context.unroute(this.mocks.get(k)!);
        await this.ctx.session.context.route(pattern, (route) =>
          route.fulfill({
            status: step.status ?? 200,
            headers: step.headers,
            body: typeof step.body === "string" ? step.body : JSON.stringify(step.body ?? {}),
            contentType: typeof step.body === "string" ? undefined : "application/json",
          }),
        );
        this.mocks.set(k, pattern);
        return undefined;
      }
      case "removeMock": {
        const pattern = this.mocks.get(step.key);
        if (pattern) await this.ctx.session.context.unroute(pattern);
        this.mocks.delete(step.key);
        return undefined;
      }
      case "header":
        this.extraHeaders[step.name] = this.str(step.value);
        await this.ctx.session.context.setExtraHTTPHeaders(this.extraHeaders);
        return undefined;

      // ----------------------------------------------------- Storage/auth
      case "cookie": {
        const url = page.url().startsWith("http") ? page.url() : this.opts.baseUrl;
        const [pair, ...attrs] = this.str(step.value).split(";");
        const [name, ...v] = pair.split("=");
        const cookie: Parameters<typeof this.ctx.session.context.addCookies>[0][0] = { name: name.trim(), value: v.join("=").trim(), url };
        for (const a of attrs) {
          const [k, val] = a.split("=").map((x) => x.trim());
          if (/^domain$/i.test(k)) {
            cookie.domain = val;
            cookie.path = cookie.path ?? "/";
            delete cookie.url;
          }
          if (/^path$/i.test(k)) cookie.path = val;
        }
        await this.ctx.session.context.addCookies([cookie]);
        return undefined;
      }
      case "localStorage":
        await page.evaluate(([k, v]) => localStorage.setItem(k, v), [this.str(step.key), this.str(step.value)]);
        return undefined;
      case "authSave": {
        const state = await this.ctx.session.context.storageState({ indexedDB: true });
        if (step.path) {
          const file = resolveFrom(fileDir, this.str(step.path));
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, JSON.stringify(state, null, 2));
        }
        return state;
      }
      case "authLoad": {
        const file = resolveFrom(fileDir, this.str(step.path));
        const state = JSON.parse(readFileSync(file, "utf8"));
        await this.ctx.session.context.addCookies(state.cookies ?? []);
        for (const origin of state.origins ?? []) {
          const p = await this.ctx.session.context.newPage();
          await p.goto(origin.origin).catch(() => {});
          await p.evaluate((items: Array<{ name: string; value: string }>) => {
            for (const i of items) localStorage.setItem(i.name, i.value);
          }, origin.localStorage ?? []);
          await p.close();
        }
        return undefined;
      }
      case "dialog":
        page.once("dialog", (d) => void (step.action === "accept" ? d.accept(step.text) : d.dismiss()));
        return undefined;

      // -------------------------------------------------------------- Code
      case "javascript": {
        let code = step.code;
        if (/^\.{1,2}\/.*\.(m?js|ts)$/.test(code.trim())) code = readFileSync(resolveFrom(fileDir, code.trim()), "utf8");
        if (step.environment === "browser") {
          return page.evaluate(
            ({ code, env }) => new Function("env", `return (async () => {\n${code}\n})()`)(env),
            { code, env: JSON.parse(JSON.stringify(this.env)) },
          );
        }
        return runNodeScript(code, this.env);
      }

      // -------------------------------------------------------------- Flow
      case "if": {
        const ok = await this.evalCondition(step.condition, `${key}.if`, fileDir);
        const branch = ok ? step.then : (step.else ?? []);
        const children = await this.runSteps(branch, `${path}.${ok ? "then" : "else"}`, fileDir);
        if (result) result.children = children;
        if (children.some((c) => c.status === "failed")) throw new StepFailure("A step inside the conditional failed");
        return undefined;
      }
      case "while": {
        const max = step.maxIterations ?? 100;
        const children: StepResult[] = [];
        for (let i = 0; i < max; i++) {
          if (step.condition && !(await this.evalCondition(step.condition, `${key}.while`, fileDir))) break;
          const r = await this.runSteps(step.do, `${path}.do#${i}`, fileDir);
          children.push(...r);
          if (r.some((c) => c.status === "failed")) {
            if (result) result.children = children;
            throw new StepFailure(`A step inside the loop failed (iteration ${i + 1})`);
          }
        }
        if (result) result.children = children;
        return undefined;
      }
      case "module":
        return this.runModule(step, path, fileDir, result);
    }
  }

  private async checkElement(
    step: Extract<Step, { cmd: "checkElement" }>,
    key: string,
    result: StepResult | undefined,
    T: (t: Target) => Promise<{ locator?: Locator }>,
  ): Promise<undefined> {
    const negative = step.check === "notVisible" || step.check === "notExists";
    if (negative) {
      // For absence checks, AI "not found" is the passing outcome.
      const deadline = Date.now() + (step.timeout ?? this.cfg.browser.elementCheckTimeoutMs);
      for (;;) {
        let present = false;
        try {
          const t = await this.target(step.target, key, { ...step, cache: false }, result);
          present = step.check === "notVisible" ? await t.locator!.isVisible() : (await t.locator!.count()) > 0;
        } catch {
          present = false;
        }
        if (!present) return undefined;
        if (Date.now() > deadline) throw new StepFailure(`Element is ${step.check === "notVisible" ? "visible" : "present"}`, step.soft);
        await sleep(300);
      }
    }
    const t = await T(step.target);
    await this.poll(step, async () => {
      const l = t.locator!;
      switch (step.check) {
        case "visible": return (await l.isVisible()) ? null : "Element is not visible";
        case "exists": return (await l.count()) > 0 ? null : "Element does not exist";
        case "enabled": return (await l.isEnabled()) ? null : "Element is disabled";
        case "disabled": return (await l.isDisabled()) ? null : "Element is enabled";
        case "checked": return (await l.isChecked()) ? null : "Element is not checked";
        case "notChecked": return (await l.isChecked()) ? "Element is checked" : null;
      }
      return null;
    });
    return undefined;
  }

  /** Poll a check until it returns null (pass) or the timeout elapses. */
  private async poll(step: Step, check: () => Promise<string | null>): Promise<void> {
    const deadline = Date.now() + (step.timeout ?? this.cfg.browser.elementCheckTimeoutMs);
    for (;;) {
      const problem = await check().catch((e) => errMsg(e));
      if (problem === null) return;
      if (Date.now() > deadline) throw new StepFailure(problem, step.soft);
      await sleep(250);
    }
  }

  private async evalCondition(cond: Step, key: string, fileDir: string): Promise<boolean> {
    if (cond.cmd === "javascript") return !!(await this.execute(cond, key, fileDir, undefined));
    try {
      // Conditions should be quick: don't wait out the full check timeout.
      await this.execute({ ...cond, timeout: cond.timeout ?? 1500, soft: false }, key, fileDir, undefined);
      return true;
    } catch {
      return false;
    }
  }

  private async runModule(step: Extract<Step, { cmd: "module" }>, path: string, fileDir: string, result: StepResult | undefined) {
    const file = resolveFrom(fileDir, this.str(step.path));
    if (!existsSync(file)) throw new StepFailure(`Module not found: ${file}`);
    const mod = parseFile(file) as ModuleFile;
    if (mod.kind !== "module") throw new StepFailure(`${file} is not a module`);
    // Modules run with their parameters layered over the caller's env.
    const saved: Record<string, unknown> = {};
    for (const p of mod.parameters) {
      saved[p.name] = this.env[p.name];
      const input = step.inputs?.[p.name] ?? p.default;
      if (input === undefined) {
        if (!(p.name in this.env)) throw new StepFailure(`Module ${mod.name ?? mod.id} needs input ${p.name}`);
        continue;
      }
      const v = "string" in input ? this.str(input.string) : evalExpression(input.javascript, this.env);
      if (p.enum && !p.enum.includes(String(v))) throw new StepFailure(`Input ${p.name}=${v} is not one of ${p.enum.join(", ")}`);
      this.env[p.name] = v;
    }
    try {
      const children = await this.runSteps(mod.steps, `${path}>${mod.id}`, dirname(file));
      if (result) result.children = children;
      if (children.some((c) => c.status === "failed")) throw new StepFailure(`Module ${mod.name ?? mod.id} failed`);
      return children.at(-1)?.value;
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete this.env[k];
        else this.env[k] = v;
      }
    }
  }

  private url(u: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
    const base = this.opts.baseUrl ?? (this.page.url().startsWith("http") ? this.page.url() : undefined);
    if (!base) throw new StepFailure(`Relative URL "${u}" needs a baseUrl`);
    return new URL(u, base).toString();
  }
}

function safeLabel(step: Step, env: Env): string {
  try {
    return interpolate(describeStep(step), env);
  } catch {
    return describeStep(step);
  }
}

function resolveFrom(dir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(dir, p);
}

async function center(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new StepFailure("Element has no bounding box");
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

function globToRegex(g: string): RegExp {
  return new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§").replace(/\*/g, "[^/]*").replace(/§/g, ".*").replace(/\?/g, ".") + "$");
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message.split("\nCall log:")[0].trim();
  return String(e);
}
