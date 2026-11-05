import type { Runner, RunSummary, StepResult, TestResult } from "@memento/core";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const green = c(32), red = c(31), yellow = c(33), dim = c(2), bold = c(1), cyan = c(36);

const ICON: Record<string, string> = { passed: green("✓"), failed: red("✘"), skipped: dim("○"), softFailed: yellow("!") };

/** Streams progress to the terminal. */
export function attachConsoleReporter(runner: Runner, opts: { verbose: boolean }) {
  let total = 0;
  let done = 0;
  runner.on("run:start", ({ tests }) => {
    total = tests.length;
    console.log(dim(`Running ${tests.length} test${tests.length === 1 ? "" : "s"}…\n`));
  });
  runner.on("test:start", ({ file, attempt }) => {
    if (opts.verbose) console.log(`${bold(file)}${attempt > 1 ? yellow(` (retry ${attempt - 1})`) : ""}`);
  });
  runner.on("step:end", ({ result }) => {
    if (!opts.verbose || result.path.includes(".ai[")) return;
    const depth = (result.path.match(/[.>]/g) ?? []).length;
    const tag = result.resolution === "cache" ? dim(" [cache]") : result.resolution === "healed" ? yellow(" [healed]") : "";
    const ai = result.ai.length ? dim(` · ${result.ai.length} AI call${result.ai.length > 1 ? "s" : ""}`) : "";
    console.log(`  ${"  ".repeat(depth)}${ICON[result.status]} ${result.label}${tag}${ai} ${dim(`${result.durationMs}ms`)}`);
    if (result.error && result.status !== "passed") console.log(red(indent(result.error, 6 + depth * 2)));
  });
  runner.on("test:end", (r) => {
    done++;
    const ms = (r.durationMs / 1000).toFixed(1);
    const cache = r.cache.hits || r.cache.misses ? dim(` · cache ${r.cache.hits} hit/${r.cache.misses} miss${r.cache.healed ? `/${r.cache.healed} healed` : ""}`) : "";
    console.log(`[${done}/${total}] ${ICON[r.status]} ${r.file} ${dim(`(${ms}s)`)}${dim(` · ${r.ai.calls} AI calls`)}${cache}`);
    if (r.status === "failed" && !opts.verbose) printFailure(r);
    if (opts.verbose) console.log();
  });
}

function printFailure(r: TestResult) {
  const failed = findFailed([...r.before, ...r.steps, ...r.after]);
  if (failed) {
    console.log(red(`    Failed at ${failed.path}: ${failed.label}`));
    if (failed.error) console.log(red(indent(failed.error, 6)));
  } else if (r.error) console.log(red(indent(r.error, 4)));
  if (r.trace) console.log(dim(`    Trace: memento trace ${r.trace}`));
}

function findFailed(rs: StepResult[]): StepResult | undefined {
  for (const s of rs) {
    if (s.status === "failed") return findFailed(s.children ?? []) ?? s;
  }
  return undefined;
}

export function printSummary(s: RunSummary) {
  const tokens = s.results.reduce((n, r) => n + r.ai.inputTokens + r.ai.outputTokens, 0);
  console.log();
  console.log(
    `  Tests     ${s.failed ? red(`${s.failed} failed`) + " | " : ""}${green(`${s.passed} passed`)}${s.skipped ? ` | ${dim(`${s.skipped} skipped`)}` : ""} (${s.results.length})`,
  );
  console.log(`  Duration  ${(s.durationMs / 1000).toFixed(1)}s`);
  console.log(`  AI tokens ${tokens.toLocaleString()}`);
  console.log(`  Results   ${dim(s.outputDir)}`);
}

function indent(s: string, n: number) {
  return s
    .split("\n")
    .map((l) => " ".repeat(n) + l)
    .join("\n");
}
