import { z } from "zod";
import type { AIClient } from "../ai/client.js";
import { parseFile } from "../format/parse.js";
import { buildRepoContext } from "./repo-context.js";

/**
 * Test-author agent: read a repository and draft Memento tests for it.
 * Every draft is parsed with the real parser; invalid YAML gets one repair
 * round with the parser's error, and anything still invalid is dropped.
 */

const AUTHOR_SYSTEM = `You write end-to-end tests for a web application in Memento's YAML format, based on its source code.

FORMAT (follow exactly):
fileType: memento/test/v1
id: kebab-case-id            # unique, <= 36 chars
description: One sentence on what the test proves
url: /path                   # relative to the base URL
labels: [smoke]              # optional
steps:
  - click: the Sign in button               # element described in natural language
  - fill:
      text: "{{ env.QA_EMAIL }}"
      into: the Email field
  - type: { text: hello, into: the Search field, pressEnter: true }
  - select: { option: Price low to high, from: the Sort dropdown }
  - navigate: /pricing
  - checkElementVisible: the account menu
  - checkPageContains: Order confirmed
  - assert: The cart shows 1 item           # AI check: short, one fact, durable (no toasts/spinners)
  - act:                                    # AI action for a goal whose exact clicks may vary
      goal: Add the first product to the cart and open checkout
      postcondition: The checkout page shows the product
  - extract: { goal: the order number, saveAs: ORDER_ID }
Each list item has exactly ONE command key; options go under that key.
Optional sections: before: [...], after: [...]. Control flow: - if: { checkElementVisible: the cookie banner, then: [ { click: Accept all } ] }

HOW TO WRITE GOOD TESTS
- Derive flows from the code: routes, forms, buttons, labels and copy you can see. Use the real visible labels from the code.
- Describe elements by purpose/role + visible label ("the Create project button"), never CSS selectors or test ids.
- Put text in 'single quotes' only when an exact value matters.
- Every state-changing action is followed by an assertion of its durable outcome.
- Credentials and secrets are NEVER hard-coded: use {{ env.QA_EMAIL }}, {{ env.QA_PASSWORD }} etc., and list the variables you used.
- Prefer a few high-value tests (critical user journeys: sign-up/log-in, the core feature, checkout/payment if present, key navigation) over many shallow ones.
- Don't write tests that need real payments, emails or destructive actions on shared data unless the request asks for it.
- Each test must be independent (it can't rely on another test having run).
- Use preset steps when the path is clear from the code; use act for multi-step goals where the UI may vary.

Respond with JSON only.`;

const AuthorOutput = z.object({
  analysis: z.string().describe("What the app does and which journeys matter most."),
  tests: z.array(
    z.object({
      fileName: z.string().describe("e.g. log-in.test.yaml"),
      yaml: z.string(),
      rationale: z.string(),
      variables: z.array(z.string()).describe("env variables the test needs, e.g. QA_EMAIL"),
    }),
  ),
});

export interface DraftTest {
  fileName: string;
  yaml: string;
  rationale: string;
  variables: string[];
  valid: boolean;
  error?: string;
}

export interface AuthorResult {
  analysis: string;
  tests: DraftTest[];
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export async function authorTests(
  ai: AIClient,
  opts: { repoDir: string; request?: string; baseUrl?: string; maxTests?: number; signal?: AbortSignal },
): Promise<AuthorResult> {
  const ctx = buildRepoContext(opts.repoDir);
  const max = opts.maxTests ?? 5;
  const files = ctx.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
  const ask =
    `${opts.request ? `REQUEST: ${opts.request}\n` : `Write up to ${max} tests for the most important user journeys.\n`}` +
    (opts.baseUrl ? `The app runs at ${opts.baseUrl}.\n` : "") +
    (ctx.existingTests.length ? `Existing Memento tests (don't duplicate): ${ctx.existingTests.join(", ")}\n` : "") +
    `\n<repo>\n${ctx.summary}\n\n${files}\n</repo>`;

  const usage = { inputTokens: 0, outputTokens: 0 };
  const first = await ai.generate({
    agent: "author",
    system: AUTHOR_SYSTEM,
    content: [{ type: "text", text: ask }],
    schema: AuthorOutput,
    abortSignal: opts.signal,
  });
  usage.inputTokens += first.usage.inputTokens;
  usage.outputTokens += first.usage.outputTokens;

  const tests: DraftTest[] = first.object.tests.slice(0, max).map((t) => ({ ...t, fileName: safeName(t.fileName), ...validate(t.fileName, t.yaml) }));

  // One repair round for drafts that don't parse.
  const broken = tests.filter((t) => !t.valid);
  if (broken.length) {
    const Repair = z.object({ fixes: z.array(z.object({ fileName: z.string(), yaml: z.string() })) });
    const fix = await ai.generate({
      agent: "author",
      system: AUTHOR_SYSTEM,
      content: [
        {
          type: "text",
          text: `These drafts failed to parse. Fix only the YAML structure, keep the intent.\n\n${broken
            .map((b) => `FILE ${b.fileName}\nERROR: ${b.error}\n${b.yaml}`)
            .join("\n\n")}`,
        },
      ],
      schema: Repair,
      abortSignal: opts.signal,
    });
    usage.inputTokens += fix.usage.inputTokens;
    usage.outputTokens += fix.usage.outputTokens;
    for (const f of fix.object.fixes) {
      const t = tests.find((x) => x.fileName === safeName(f.fileName));
      if (!t) continue;
      const v = validate(t.fileName, f.yaml);
      if (v.valid) Object.assign(t, { yaml: f.yaml, valid: true, error: undefined });
    }
  }
  return { analysis: first.object.analysis, tests, model: first.model, usage };
}

function validate(fileName: string, yaml: string): { valid: boolean; error?: string } {
  try {
    const f = parseFile(`/${safeName(fileName)}`, yaml);
    if (f.kind !== "test") return { valid: false, error: "not a test file" };
    return { valid: true };
  } catch (e) {
    return { valid: false, error: (e as Error).message };
  }
}

function safeName(n: string): string {
  const base = n.split(/[\\/]/).pop()!.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
  return base.endsWith(".test.yaml") ? base : `${base.replace(/\.ya?ml$/, "")}.test.yaml`;
}
