import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentName } from "../config.js";

/**
 * Local, file-based knowledge base (`.memento/knowledge/*.yaml`).
 *
 * Three kinds of entries, matching what testers actually need to tell an agent:
 *  - terminology: what a product-specific word means in the UI
 *  - rule: a binding instruction for one agent (or all)
 *  - flow: a known multi-step journey with an expected end state
 *
 * Entries live in the repo, so they are reviewed and versioned like tests.
 * Retrieval is lexical for now; an embedding retriever can be plugged in later
 * through the same `retrieve` signature.
 */
export type KnowledgeEntry =
  | { type: "terminology"; term: string; definition: string; examples?: string[]; scope?: Scope }
  | { type: "rule"; title: string; agent?: AgentName | "all"; instruction: string; scope?: Scope }
  | { type: "flow"; intent: string; steps: string[]; successState: string; scope?: Scope };

export interface Scope {
  tests?: string[];
}

export class KnowledgeBase {
  constructor(public readonly entries: KnowledgeEntry[] = []) {}

  static load(dir: string): KnowledgeBase {
    if (!existsSync(dir)) return new KnowledgeBase();
    const entries: KnowledgeEntry[] = [];
    for (const f of readdirSync(dir)) {
      if (!/\.ya?ml$/.test(f)) continue;
      const doc = parseYaml(readFileSync(join(dir, f), "utf8"));
      const list = Array.isArray(doc) ? doc : Array.isArray(doc?.entries) ? doc.entries : [];
      for (const e of list) if (e && typeof e === "object" && "type" in e) entries.push(e as KnowledgeEntry);
    }
    return new KnowledgeBase(entries);
  }

  /** Return entries relevant to an agent call, formatted for a prompt. */
  retrieve(agent: AgentName, query: string, testId?: string, maxChars = 4000): string {
    const words = tokenize(query);
    const scored: Array<{ score: number; text: string }> = [];
    for (const e of this.entries) {
      if (e.scope?.tests && testId && !e.scope.tests.includes(testId)) continue;
      if (e.type === "rule") {
        if (e.agent && e.agent !== "all" && e.agent !== agent) continue;
        // Rules are binding: always include rules for this agent, ranked first.
        scored.push({ score: 1000, text: `RULE (${e.title}): ${e.instruction}` });
        continue;
      }
      const text =
        e.type === "terminology"
          ? `TERM "${e.term}": ${e.definition}${e.examples?.length ? ` (e.g. ${e.examples.join("; ")})` : ""}`
          : `FLOW "${e.intent}": ${e.steps.map((s, i) => `${i + 1}. ${s}`).join(" ")} → success when: ${e.successState}`;
      const score = overlap(words, tokenize(text));
      if (score > 0) scored.push({ score, text });
    }
    scored.sort((a, b) => b.score - a.score);
    const out: string[] = [];
    let size = 0;
    for (const s of scored) {
      if (size + s.text.length > maxChars) break;
      out.push(`- ${s.text}`);
      size += s.text.length;
    }
    return out.join("\n");
  }
}

const STOP = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "on", "is", "be", "with", "for", "that", "this", "it", "at", "by"]);
function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)));
}
function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}
