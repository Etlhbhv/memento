import type { AgentName } from "../src/config.js";
import type { AIClient, AIRequest, AIResponse } from "../src/ai/client.js";

/**
 * Deterministic stand-in for a model, used to test the whole pipeline
 * (snapshot → agent → element → action → cache) without network access.
 * - locator: word-overlap match against the element tree
 * - assertion/review: checks 'quoted' or "quoted" text exists in the page text
 * - act: replays a scripted list of turns
 */
export class FakeAI implements AIClient {
  calls: Array<{ agent: AgentName; text: string }> = [];
  actScript: unknown[] = [];

  supportsVision() {
    return false;
  }
  modelFor() {
    return "fake:model";
  }

  async generate<T>(req: AIRequest<T>): Promise<AIResponse<T>> {
    const text = req.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
    this.calls.push({ agent: req.agent, text });
    let out: unknown;
    switch (req.agent) {
      case "locator":
        out = this.locate(text);
        break;
      case "assertion":
        out = this.assert(text);
        break;
      case "review":
        out = { reasoning: "ok", relevantElementIds: [], pageLooksUnsettled: false, passed: true };
        break;
      case "act":
        out = this.actScript.shift() ?? { thought: "out of script", plan: [], action: { type: "finish", success: false, message: "no script", postcondition: null } };
        break;
      case "extract": {
        const m = text.match(/Cart: (\d+) items/);
        out = { reasoning: "read cart", found: !!m, value: m ? m[1] : null };
        break;
      }
      case "author": {
        const yaml = "fileType: memento/test/v1\nid: sign-in\ndescription: Signs in\nurl: /\nsteps:\n  - fill:\n      text: \"{{ env.QA_EMAIL }}\"\n      into: the Email field\n  - click: the Sign in button\n";
        out = text.includes("failed to parse")
          ? { fixes: [{ fileName: "broken.test.yaml", yaml: yaml.replace("sign-in", "broken") }] }
          : {
              analysis: "A shop with a sign-in form.",
              tests: [
                { fileName: "sign-in.test.yaml", yaml, rationale: "Core journey", variables: ["QA_EMAIL"] },
                { fileName: "broken.test.yaml", yaml: "fileType: memento/test/v1\nid: broken\nsteps:\n  - click: a\n    retries: 1\n", rationale: "x", variables: [] },
              ],
            };
        break;
      }
      case "recovery": {
        const banner = text.match(/\[(\d+)\] button "Accept all"/);
        out = banner
          ? { reasoning: "cookie banner", recoverable: true, actions: [{ type: "click", elementId: Number(banner[1]), description: "the Accept all button" }] }
          : { reasoning: "nothing", recoverable: false, actions: [] };
        break;
      }
    }
    return { object: req.schema.parse(out), model: "fake:model", usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 0 };
  }

  private locate(text: string) {
    const desc = (text.match(/Element description: (.*)/)?.[1] ?? "").toLowerCase();
    const words = desc.split(/[^a-z0-9@]+/).filter((w) => w.length > 2 && !["the", "button", "field", "input", "for"].includes(w));
    let best: { id: number; score: number } | null = null;
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*\[(\d+)\] (\S+)(.*)$/);
      if (!m) continue;
      const hay = (m[2] + " " + m[3]).toLowerCase();
      let score = words.filter((w) => hay.includes(w)).length;
      if (desc.includes("button") && m[2] === "button") score += 0.5;
      if ((desc.includes("field") || desc.includes("input")) && m[2] === "textbox") score += 0.5;
      if (score > 0 && (!best || score > best.score)) best = { id: Number(m[1]), score };
    }
    return {
      reasoning: best ? "best word overlap" : "no match",
      elementId: best?.id ?? null,
      signals: { text: true, role: true, attributes: [], visual: false, position: false, relatedElementIds: [] },
    };
  }

  private assert(text: string) {
    const statement = text.match(/Statement to check: (.*)/)?.[1] ?? "";
    const quoted = [...statement.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
    const pageText = text.split("Visible page text:")[1] ?? text;
    const passed = quoted.length > 0 && quoted.every((q) => pageText.includes(q));
    return { reasoning: `quoted ${JSON.stringify(quoted)} ${passed ? "found" : "missing"}`, relevantElementIds: [], pageLooksUnsettled: false, passed };
  }
}
