import { z } from "zod";
import { cacheKey } from "../../cache/store.js";
import { checkAssertion } from "./assertion.js";
import { callAgent, observe, type AgentContext } from "./context.js";

/**
 * AI action (`act`): reach a natural-language goal.
 *
 * Lifecycle (same shape as Momentic's AI action v3, implemented independently):
 *   1. precondition (protected; the agent can't edit it)
 *   2. replay the cached trajectory, if any — no planning calls
 *   3. on cache miss or a replay that fails, run the agent loop from the
 *      CURRENT page state (healing), one action per turn
 *   4. the agent can't pass itself: an independent reviewer checks the goal
 *      and the protected postcondition
 *   5. on success, the concrete trajectory is cached for next time
 */

const El = { elementId: z.number().int(), description: z.string().describe("Durable natural-language description of the element.") };

export const ActAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), ...El }),
  z.object({ type: z.literal("doubleClick"), ...El }),
  z.object({ type: z.literal("rightClick"), ...El }),
  z.object({ type: z.literal("hover"), ...El }),
  z.object({ type: z.literal("fill"), ...El, text: z.string() }),
  z.object({ type: z.literal("type"), ...El, text: z.string(), pressEnter: z.boolean() }),
  z.object({ type: z.literal("select"), ...El, option: z.string() }),
  z.object({ type: z.literal("press"), keys: z.string().describe('Key or combo, e.g. "Enter", "Control+A".') }),
  z.object({ type: z.literal("scroll"), direction: z.enum(["up", "down"]), elementId: z.number().int().nullable() }),
  z.object({ type: z.literal("navigate"), url: z.string() }),
  z.object({ type: z.literal("goBack") }),
  z.object({ type: z.literal("wait"), ms: z.number().int().max(10000) }),
  z.object({ type: z.literal("clickCoords"), x: z.number(), y: z.number(), description: z.string() }),
  z.object({
    type: z.literal("finish"),
    success: z.boolean(),
    message: z.string(),
    postcondition: z.string().nullable().describe("When success: a durable, checkable statement of the end state."),
  }),
]);
export type ActAction = z.infer<typeof ActAction>;

const ActTurn = z.object({
  thought: z.string(),
  plan: z.array(z.string()),
  action: ActAction,
});

/** Executes concrete steps on behalf of the agent (implemented by the runner). */
export interface ActHost {
  /**
   * Run one concrete step (YAML-shaped, e.g. `{ click: "the Save button" }`).
   * `pinnedElementId` lets the live agent act on the exact element it chose
   * without a second locator call; replays resolve by description via cache.
   */
  exec(step: Record<string, unknown>, key: string, pinnedElementId?: number): Promise<{ ok: boolean; error?: string }>;
}

export interface ActResult {
  source: "cache" | "ai" | "healed";
  steps: number;
  message: string;
  trajectory: Array<Record<string, unknown>>;
}

export class ActFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActFailedError";
  }
}

export async function runAct(
  ctx: AgentContext,
  host: ActHost,
  opts: {
    goal: string;
    precondition?: string;
    postcondition?: string;
    useCache: boolean;
    stepKey: string;
    maxSteps: number;
    variablesHint?: string;
  },
): Promise<ActResult> {
  const actKey = cacheKey("act", opts.stepKey, opts.goal);
  const subKey = (i: number) => `${actKey}/${i}`;

  if (opts.precondition) {
    const pre = await checkAssertion(ctx, opts.precondition);
    if (!pre.passed) throw new ActFailedError(`Precondition failed: ${opts.precondition} — ${pre.reasoning}`);
  }

  const history: string[] = [];
  let trajectory: Array<Record<string, unknown>> = [];
  let source: ActResult["source"] = "ai";

  // ---- Replay ----
  const cached = opts.useCache && ctx.cache.enabled ? ctx.cache.get(actKey, "act") : undefined;
  if (cached) {
    let failedAt = -1;
    let failure = "";
    for (let i = 0; i < cached.trajectory.length; i++) {
      const r = await host.exec(cached.trajectory[i], subKey(i));
      if (!r.ok) {
        failedAt = i;
        failure = r.error ?? "step failed";
        break;
      }
    }
    if (failedAt < 0) {
      const post = opts.postcondition ?? cached.postcondition;
      const verdict = post ? await checkAssertion(ctx, post) : { passed: true, reasoning: "" };
      if (verdict.passed) {
        ctx.cache.stats.hits++;
        return { source: "cache", steps: cached.trajectory.length, message: "Replayed cached trajectory", trajectory: cached.trajectory };
      }
      failure = `replayed all steps but the end state was not reached (${post}): ${verdict.reasoning}`;
      trajectory = [...cached.trajectory];
      history.push(`A previously recorded path was replayed in full, but the goal is not reached: ${failure}. Continue from the current page.`);
    } else {
      trajectory = cached.trajectory.slice(0, failedAt);
      history.push(
        `A previously recorded path was replayed. Steps 1-${failedAt} succeeded:\n${cached.trajectory.slice(0, failedAt).map((s, i) => `  ${i + 1}. ${JSON.stringify(s)}`).join("\n")}\n` +
          `Step ${failedAt + 1} (${JSON.stringify(cached.trajectory[failedAt])}) failed: ${failure}\nContinue toward the goal from the current page.`,
      );
    }
    ctx.cache.stats.misses++;
    source = "healed";
  }

  // ---- Agent loop ----
  let noProgress = 0;
  for (let turn = 0; turn < opts.maxSteps; turn++) {
    const { content } = await observe(ctx, "act", { marks: true });
    const prompt =
      `GOAL: ${opts.goal}\n` +
      (opts.precondition ? `PRECONDITION (already verified): ${opts.precondition}\n` : "") +
      (opts.postcondition ? `REQUIRED POSTCONDITION (must be true when you finish): ${opts.postcondition}\n` : "") +
      (opts.variablesHint ? `${opts.variablesHint}\n` : "") +
      `Budget: ${opts.maxSteps - turn} actions left.\n\n<history>\n${history.length ? history.join("\n") : "(no actions yet)"}\n</history>`;
    const res = await callAgent(ctx, "act", "act", opts.goal, {
      content: [{ type: "text", text: prompt }, ...content],
      schema: ActTurn,
    });
    const { action, thought } = res.object;

    if (action.type === "finish") {
      if (!action.success) throw new ActFailedError(`AI action could not complete the goal: ${action.message}`);
      const goalCheck = `The goal "${opts.goal}" has been achieved.${opts.postcondition ? ` Required postcondition: ${opts.postcondition}` : ""}`;
      const review = await checkAssertion(ctx, goalCheck, {
        agentName: "review",
        timeoutMs: 1000,
        extraContext: `Actions the agent took:\n${trajectory.map((s, i) => `${i + 1}. ${JSON.stringify(s)}`).join("\n") || "(none)"}\nAgent's claim: ${action.message}`,
      });
      if (!review.passed) {
        history.push(`You called finish(success) but the independent reviewer REJECTED it: ${review.reasoning}. Keep working.`);
        continue;
      }
      const postcondition = opts.postcondition ?? action.postcondition ?? undefined;
      if (opts.useCache && ctx.cache.enabled) {
        ctx.cache.set(actKey, { kind: "act", goal: opts.goal, trajectory, postcondition, savedAt: Date.now() });
      }
      return { source, steps: trajectory.length, message: action.message, trajectory };
    }

    const { step, pinned } = actionToStep(action);
    const idx = trajectory.length;
    const r = await host.exec(step, subKey(idx), pinned);
    const line = `${turn + 1}. thought: ${thought}\n   action: ${JSON.stringify(step)} → ${r.ok ? "ok" : `FAILED: ${r.error}`}`;
    history.push(line);
    if (r.ok) {
      trajectory.push(step);
      noProgress = 0;
    } else if (++noProgress >= 3) {
      throw new ActFailedError(`AI action stopped after repeated failed actions. Last error: ${r.error}`);
    }
  }
  throw new ActFailedError(`AI action ran out of its ${opts.maxSteps}-action budget before reaching the goal.`);
}

/** Convert an agent action to a concrete, cacheable Memento step. */
export function actionToStep(a: Exclude<ActAction, { type: "finish" }>): { step: Record<string, unknown>; pinned?: number } {
  switch (a.type) {
    case "click":
    case "doubleClick":
    case "rightClick":
    case "hover":
      return { step: { [a.type]: a.description }, pinned: a.elementId };
    case "fill":
      return { step: { fill: { text: a.text, into: a.description } }, pinned: a.elementId };
    case "type":
      return { step: { type: { text: a.text, into: a.description, pressEnter: a.pressEnter } }, pinned: a.elementId };
    case "select":
      return { step: { select: { option: a.option, from: a.description } }, pinned: a.elementId };
    case "press":
      return { step: { press: a.keys } };
    case "scroll":
      return { step: { [a.direction === "up" ? "scrollUp" : "scrollDown"]: {} } };
    case "navigate":
      return { step: { navigate: a.url } };
    case "goBack":
      return { step: { goBack: {} } };
    case "wait":
      return { step: { wait: a.ms } };
    case "clickCoords":
      return { step: { click: { coords: `${a.x}, ${a.y}`, comment: a.description } } };
  }
}
