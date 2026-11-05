import { z } from "zod";
import { sleep } from "../../browser/session.js";
import { callAgent, observe, type AgentContext } from "./context.js";

const AssertionOutput = z.object({
  reasoning: z.string().describe("Step-by-step check of the statement against the page."),
  relevantElementIds: z.array(z.number().int()).describe("Ids of the elements that prove or disprove the statement."),
  pageLooksUnsettled: z.boolean().describe("True if the page appears to still be loading."),
  passed: z.boolean(),
});

export interface AssertionResult {
  passed: boolean;
  reasoning: string;
  attempts: number;
}

/**
 * Evaluate a natural-language statement against the current page.
 * A false verdict is re-checked (after the page settles) while the timeout
 * allows, so assertions don't fail just because data arrived 1s late.
 */
export async function checkAssertion(
  ctx: AgentContext,
  statement: string,
  opts: { visual?: boolean; timeoutMs?: number; agentName?: "assertion" | "review"; extraContext?: string } = {},
): Promise<AssertionResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? ctx.session.cfg.elementCheckTimeoutMs);
  const agent = opts.agentName ?? "assertion";
  let attempts = 0;
  let last = { passed: false, reasoning: "" };
  for (;;) {
    attempts++;
    await ctx.session.settle(Math.max(300, Math.min(3000, deadline - Date.now())));
    const content = opts.visual
      ? [{ type: "image" as const, data: await ctx.session.screenshot(), mediaType: "image/jpeg" }]
      : (await observe(ctx, agent, { text: true })).content;
    const res = await callAgent(ctx, agent, opts.visual ? "visualAssertion" : agent === "review" ? "review" : "assertion", statement, {
      content: [
        { type: "text", text: `${opts.extraContext ? `${opts.extraContext}\n\n` : ""}Statement to check: ${statement}` },
        ...content,
      ],
      schema: AssertionOutput,
    });
    last = { passed: res.object.passed, reasoning: res.object.reasoning };
    if (last.passed) break;
    // Only spend another call if there's time and a reason to believe the page will change.
    const remaining = deadline - Date.now();
    if (remaining < 1000 || attempts >= 3) break;
    if (!res.object.pageLooksUnsettled && attempts >= 2) break;
    await sleep(Math.min(1500, remaining / 2));
  }
  return { ...last, attempts };
}
