import { z } from "zod";
import type { ElementFingerprint } from "../../browser/inpage.js";
import { sleep } from "../../browser/session.js";
import { cachedElementStillValid, type LocatorSignals } from "../../cache/store.js";
import { callAgent, observe, type AgentContext } from "./context.js";

const LocatorOutput = z.object({
  reasoning: z.string().describe("Brief reasoning about which element matches."),
  elementId: z.number().int().nullable().describe("The [id] of the matching element, or null if not on the page."),
  // Classification comes AFTER the answer on purpose.
  signals: z.object({
    text: z.boolean(),
    role: z.boolean(),
    attributes: z.array(z.string()),
    visual: z.boolean(),
    position: z.boolean(),
    relatedElementIds: z.array(z.number().int()),
  }),
});

export type LocateResult = {
  fingerprint: ElementFingerprint;
  source: "cache" | "ai";
  /** True when a cache entry existed but no longer matched and AI re-resolved it. */
  healed: boolean;
  reasoning?: string;
};

export class ElementNotFoundError extends Error {
  constructor(description: string, detail?: string) {
    super(`Could not find element: "${description}"${detail ? ` — ${detail}` : ""}`);
    this.name = "ElementNotFoundError";
  }
}

/**
 * Resolve a natural-language element description to a concrete element.
 * Cache first (no model call), AI on miss, polling until the smart-wait timeout.
 */
export async function locate(
  ctx: AgentContext,
  description: string,
  cacheKey: string,
  opts: { useCache?: boolean; timeoutMs?: number } = {},
): Promise<LocateResult> {
  const useCache = opts.useCache !== false && ctx.cache.enabled;
  const deadline = Date.now() + (opts.timeoutMs ?? ctx.session.cfg.smartWaitingTimeoutMs);
  const cached = useCache ? ctx.cache.get(cacheKey, "locator") : undefined;

  // 1. Cache: poll briefly — the element may still be rendering.
  if (cached) {
    while (true) {
      const live = await ctx.session.resolveCached(cached.fingerprint.selectors).catch(() => null);
      if (live && cachedElementStillValid(cached, live.fingerprint, live.votes)) {
        ctx.cache.stats.hits++;
        // Refresh selectors/bbox so the entry tracks harmless drift.
        ctx.cache.set(cacheKey, { ...cached, fingerprint: live.fingerprint, savedAt: Date.now() });
        return { fingerprint: live.fingerprint, source: "cache", healed: false };
      }
      if (Date.now() > deadline - 1500) break;
      await sleep(250);
    }
    ctx.cache.stats.misses++;
  }

  // 2. AI resolution, retried while the page may still be changing.
  await ctx.session.settle(Math.max(500, Math.min(3000, deadline - Date.now())));
  let lastReason = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const { content } = await observe(ctx, "locator");
    const res = await callAgent(ctx, "locator", "locator", description, {
      content: [{ type: "text", text: `Element description: ${description}` }, ...content],
      schema: LocatorOutput,
    });
    const out = res.object;
    lastReason = out.reasoning;
    if (out.elementId != null) {
      const fp = await ctx.session.fingerprint(out.elementId);
      if (fp) {
        const signals: LocatorSignals = {
          text: out.signals.text,
          role: out.signals.role,
          attributes: out.signals.attributes,
          visual: out.signals.visual,
          position: out.signals.position,
        };
        if (useCache) {
          if (cached) ctx.cache.stats.healed++;
          ctx.cache.set(cacheKey, { kind: "locator", description, fingerprint: fp, signals, savedAt: Date.now() });
        }
        return { fingerprint: fp, source: "ai", healed: !!cached, reasoning: out.reasoning };
      }
    }
    if (Date.now() > deadline) break;
    await sleep(500);
    await ctx.session.settle(Math.max(500, deadline - Date.now()));
  }
  throw new ElementNotFoundError(description, lastReason);
}
