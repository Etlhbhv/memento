import { z } from "zod";
import { ActAction, actionToStep, type ActHost } from "./act.js";
import { callAgent, observe, type AgentContext } from "./context.js";

const RecoveryOutput = z.object({
  reasoning: z.string(),
  recoverable: z.boolean(),
  actions: z.array(ActAction).max(3),
});

/**
 * Transient failure recovery: clear an obstruction (cookie banner, promo modal,
 * tour) and let the caller retry the failed step. Never edits the test.
 * Returns true if recovery actions ran.
 */
export async function tryRecover(ctx: AgentContext, host: ActHost, failedStep: string, error: string): Promise<{ recovered: boolean; reasoning: string }> {
  const { content } = await observe(ctx, "recovery", { marks: true });
  const res = await callAgent(ctx, "recovery", "recovery", `${failedStep} ${error}`, {
    content: [{ type: "text", text: `Failed step: ${failedStep}\nError: ${error}` }, ...content],
    schema: RecoveryOutput,
  });
  const out = res.object;
  if (!out.recoverable) return { recovered: false, reasoning: out.reasoning };
  let ran = 0;
  for (const a of out.actions) {
    if (a.type === "finish") break;
    const { step, pinned } = actionToStep(a);
    // Recovery steps are never cached.
    const r = await host.exec(step, "", pinned);
    if (r.ok) ran++;
  }
  return { recovered: ran > 0 || out.actions.every((a) => a.type === "wait"), reasoning: out.reasoning };
}
