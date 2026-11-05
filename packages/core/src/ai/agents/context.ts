import type { BrowserSession } from "../../browser/session.js";
import type { TestCache } from "../../cache/store.js";
import type { AgentName } from "../../config.js";
import type { KnowledgeBase } from "../../knowledge/kb.js";
import type { AIClient, AIRequest, AIResponse } from "../client.js";
import { systemPrompt, type PromptName, type PromptOverrides } from "../prompts.js";

export interface AICallRecord {
  agent: AgentName;
  model: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  /** The model's structured answer (kept for the run viewer). */
  output: unknown;
}

/** Everything an agent needs, scoped to one running test. */
export interface AgentContext {
  ai: AIClient;
  session: BrowserSession;
  cache: TestCache;
  kb: KnowledgeBase;
  testId: string;
  vision: boolean;
  prompts?: PromptOverrides;
  /** Called for every model call, so the runner can attach it to the current step. */
  onAICall?: (r: AICallRecord) => void;
  log?: (msg: string) => void;
  abortSignal?: AbortSignal;
}

export async function callAgent<T>(
  ctx: AgentContext,
  agent: AgentName,
  prompt: PromptName,
  query: string,
  req: Omit<AIRequest<T>, "agent" | "system">,
): Promise<AIResponse<T>> {
  const knowledge = ctx.kb.retrieve(agent, query, ctx.testId);
  const res = await ctx.ai.generate({
    ...req,
    agent,
    system: systemPrompt(prompt, ctx.prompts, knowledge),
    abortSignal: ctx.abortSignal,
  });
  ctx.onAICall?.({
    agent,
    model: res.model,
    durationMs: res.durationMs,
    inputTokens: res.usage.inputTokens,
    outputTokens: res.usage.outputTokens,
    output: res.object,
  });
  return res;
}

/** Collect what the model should see of the current page. */
export async function observe(ctx: AgentContext, agent: AgentName, opts: { text?: boolean; marks?: boolean } = {}) {
  const snap = await ctx.session.snapshot(true);
  const vision = ctx.vision && ctx.ai.supportsVision(agent);
  let shot: Buffer | undefined;
  if (vision) {
    // "Set-of-marks": draw each element's id on the screenshot so the model can
    // connect what it sees to ids in the tree.
    const ids = opts.marks ? [...snap.text.matchAll(/\[(\d+)\]/g)].slice(0, 400).map((m) => Number(m[1])) : undefined;
    shot = await ctx.session.screenshot({ marks: ids }).catch(() => undefined);
  }
  const text = opts.text ? await ctx.session.pageText().catch(() => "") : undefined;
  const header = `URL: ${snap.url}\nTitle: ${snap.title}\nViewport: ${snap.viewport.width}x${snap.viewport.height}, scrolled to (${snap.viewport.scrollX}, ${snap.viewport.scrollY})${snap.truncated ? "\n(Element tree truncated to fit the context budget.)" : ""}`;
  const content: AIRequest<unknown>["content"] = [
    { type: "text", text: `<page>\n${header}\n\n${snap.text}\n</page>` },
  ];
  if (text) content.push({ type: "text", text: `<page>\nVisible page text:\n${text.slice(0, 15000)}\n</page>` });
  if (shot) content.push({ type: "image", data: shot, mediaType: "image/jpeg" });
  return { snap, content, screenshot: shot };
}
