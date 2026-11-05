import { z } from "zod";
import { callAgent, observe, type AgentContext } from "./context.js";

/**
 * Extract structured data from the page. With a user JSON schema, the value
 * must match it; without one, a string is returned.
 */
export async function extract(ctx: AgentContext, goal: string, schema?: Record<string, unknown>): Promise<unknown> {
  await ctx.session.settle();
  const { content } = await observe(ctx, "extract", { text: true });
  const valueSchema = schema ? z.fromJSONSchema(schema as never) : z.string();
  const Out = z.object({
    reasoning: z.string(),
    found: z.boolean(),
    value: valueSchema.nullable(),
  });
  const res = await callAgent(ctx, "extract", "extract", goal, {
    content: [
      {
        type: "text",
        text: `Data to extract: ${goal}${schema ? `\nThe "value" must match this JSON schema:\n${JSON.stringify(schema)}` : ""}`,
      },
      ...content,
    ],
    schema: Out,
  });
  if (!res.object.found || res.object.value == null) {
    throw new Error(`Could not extract "${goal}": ${res.object.reasoning}`);
  }
  return res.object.value;
}
