import { randomUUID } from "node:crypto";
import vm from "node:vm";

export type Env = Record<string, unknown>;

/** Small helpers available in templates and JavaScript steps (no external deps). */
export function helpers() {
  const rand = (n: number) => Math.random().toString(36).slice(2, 2 + n);
  return {
    uuid: () => randomUUID(),
    randomString: (n = 8) => rand(n),
    randomEmail: (domain = "example.com") => `memento+${Date.now()}${rand(4)}@${domain}`,
    randomInt: (min = 0, max = 1_000_000) => Math.floor(Math.random() * (max - min + 1)) + min,
    today: () => new Date().toISOString().slice(0, 10),
  };
}

function context(env: Env, extra: Record<string, unknown> = {}) {
  return vm.createContext({
    env,
    ...helpers(),
    console,
    Date,
    Math,
    JSON,
    URL,
    URLSearchParams,
    fetch,
    setTimeout,
    TextEncoder,
    TextDecoder,
    ...extra,
  });
}

/** Evaluate a JS expression (module inputs, template contents). */
export function evalExpression(expr: string, env: Env): unknown {
  const body = /\breturn\b/.test(expr) ? `(function(){ ${expr} })()` : `(${expr})`;
  return new vm.Script(body).runInContext(context(env), { timeout: 2000 });
}

/** Replace `{{ expression }}` occurrences in a string. */
export function interpolate(s: string, env: Env): string {
  if (!s.includes("{{")) return s;
  return s.replace(/\{\{\s*([\s\S]+?)\s*\}\}/g, (_, expr: string) => {
    const v = evalExpression(expr, env);
    return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

/** Run a JavaScript step in a Node sandbox. `setVariable` writes to env. */
export async function runNodeScript(code: string, env: Env): Promise<unknown> {
  const ctx = context(env, {
    setVariable: (k: string, v: unknown) => {
      env[k] = v;
    },
  });
  const script = new vm.Script(`(async () => {\n${code}\n})()`);
  return await script.runInContext(ctx, { timeout: 30000 });
}
