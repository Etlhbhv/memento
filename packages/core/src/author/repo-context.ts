import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Build a compact picture of a code repository for the test-author agent:
 * framework, routes/pages, and the most test-relevant source files, within a
 * fixed character budget.
 */
export interface RepoContext {
  summary: string;
  framework: string[];
  routes: string[];
  files: Array<{ path: string; content: string }>;
  existingTests: string[];
  chars: number;
}

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", "coverage", ".turbo",
  "vendor", "Pods", ".venv", "venv", "__pycache__", "target", ".idea", ".vscode", "memento-results", ".memento",
]);
const SOURCE_EXT = /\.(tsx?|jsx?|vue|svelte|astro|html|py|rb|php|go|erb|hbs)$/;
const INTERESTING = /(login|signin|sign-in|signup|sign-up|register|auth|checkout|cart|payment|pricing|dashboard|settings|account|profile|onboarding|search|home|index|page|route|router|app|layout|nav|header|form)/i;

export function buildRepoContext(root: string, budgetChars = 60_000): RepoContext {
  const all: string[] = [];
  walk(root, root, all, 0);

  const framework: string[] = [];
  let pkg: Record<string, unknown> | undefined;
  if (existsSync(join(root, "package.json"))) {
    try {
      pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    } catch {}
  }
  const deps = { ...((pkg?.dependencies as object) ?? {}), ...((pkg?.devDependencies as object) ?? {}) } as Record<string, string>;
  for (const [dep, name] of [
    ["next", "Next.js"], ["react-router", "React Router"], ["react-router-dom", "React Router"], ["@remix-run/react", "Remix"],
    ["nuxt", "Nuxt"], ["vue-router", "Vue Router"], ["@sveltejs/kit", "SvelteKit"], ["astro", "Astro"], ["@angular/core", "Angular"],
    ["express", "Express"], ["react", "React"], ["vue", "Vue"], ["svelte", "Svelte"], ["@supabase/supabase-js", "Supabase"],
    ["firebase", "Firebase"], ["stripe", "Stripe"], ["next-auth", "NextAuth"], ["@clerk/nextjs", "Clerk"],
  ] as const) if (dep in deps && !framework.includes(name)) framework.push(name);
  if (all.some((f) => f.endsWith("manage.py"))) framework.push("Django");
  if (all.some((f) => f === "Gemfile")) framework.push("Rails");

  const routes = detectRoutes(all);
  const existingTests = all.filter((f) => /\.test\.ya?ml$/.test(f));

  // Rank source files: routes/pages first, then files with interesting names, small files preferred.
  const sources = all.filter((f) => SOURCE_EXT.test(f) && !/\.(test|spec|stories|d)\.[jt]sx?$/.test(f));
  const score = (f: string) =>
    (routes.some((r) => r.file === f) ? 10 : 0) + (INTERESTING.test(f) ? 5 : 0) + (/(components|pages|app|routes|views|src)\//.test(f) ? 1 : 0) - f.split("/").length * 0.2;
  sources.sort((a, b) => score(b) - score(a));

  const files: RepoContext["files"] = [];
  let chars = 0;
  const add = (path: string, maxPerFile: number) => {
    if (files.some((f) => f.path === path)) return;
    let content: string;
    try {
      content = readFileSync(join(root, path), "utf8");
    } catch {
      return;
    }
    if (content.length > maxPerFile) content = content.slice(0, maxPerFile) + "\n… (truncated)";
    if (chars + content.length > budgetChars) return;
    files.push({ path, content });
    chars += content.length;
  };
  for (const f of ["README.md", "readme.md"]) if (all.includes(f)) add(f, 3000);
  if (pkg) add("package.json", 3000);
  for (const t of existingTests.slice(0, 5)) add(t, 2000);
  for (const f of sources) {
    if (chars > budgetChars * 0.95) break;
    add(f, 6000);
  }

  const summary =
    `Repository with ${all.length} files. Framework: ${framework.join(", ") || "unknown"}.\n` +
    `Routes/pages detected:\n${routes.map((r) => `  ${r.route}  (${r.file})`).join("\n") || "  (none detected)"}\n` +
    `File tree (abridged):\n${abridgedTree(all)}`;

  return { summary, framework, routes: routes.map((r) => r.route), files, existingTests, chars: chars + summary.length };
}

function walk(root: string, dir: string, out: string[], depth: number) {
  if (depth > 12 || out.length > 20_000) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (IGNORE_DIRS.has(e) || (e.startsWith(".") && e !== ".github")) continue;
    const p = join(dir, e);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) walk(root, p, out, depth + 1);
    else if (st.size < 500_000) out.push(relative(root, p).split("\\").join("/"));
  }
}

/** Derive URL routes from common file-based routing conventions. */
export function detectRoutes(files: string[]): Array<{ route: string; file: string }> {
  const out: Array<{ route: string; file: string }> = [];
  for (const f of files) {
    let m: RegExpMatchArray | null;
    // Next.js app router: app/(group)/foo/[id]/page.tsx
    if ((m = f.match(/^(?:src\/)?app\/(.*?)\/?page\.(tsx?|jsx?|mdx)$/))) {
      out.push({ route: "/" + m[1].split("/").filter((s) => s && !/^\(.*\)$/.test(s)).join("/"), file: f });
    } else if ((m = f.match(/^(?:src\/)?pages\/(.*)\.(tsx?|jsx?|vue|astro|svelte)$/)) && !/^(_app|_document|_error|api\/)/.test(m[1])) {
      // Next.js pages router, Nuxt, Astro
      out.push({ route: "/" + m[1].replace(/(^|\/)index$/, "").replace(/\[(\.\.\.)?([^\]]+)\]/g, ":$2"), file: f });
    } else if ((m = f.match(/^src\/routes\/(.*?)\/?\+page\.svelte$/))) {
      out.push({ route: "/" + m[1], file: f });
    } else if ((m = f.match(/^app\/routes\/(.*)\.(tsx?|jsx?)$/))) {
      // Remix flat routes: foo.bar.$id.tsx
      out.push({ route: "/" + m[1].replace(/^_index$/, "").replace(/\._index$/, "").replace(/\./g, "/").replace(/\$/g, ":"), file: f });
    } else if (/\.html$/.test(f) && !f.includes("/") ) {
      out.push({ route: "/" + f.replace(/index\.html$/, ""), file: f });
    }
  }
  return out.sort((a, b) => a.route.localeCompare(b.route)).slice(0, 200);
}

function abridgedTree(files: string[]): string {
  const dirs = new Map<string, number>();
  for (const f of files) {
    const d = f.includes("/") ? f.split("/").slice(0, 2).join("/") : ".";
    dirs.set(d, (dirs.get(d) ?? 0) + 1);
  }
  return [...dirs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60)
    .map(([d, n]) => `  ${d}/ (${n} files)`)
    .join("\n");
}
