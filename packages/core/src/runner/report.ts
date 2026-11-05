import { flatten, type RunSummary, type TestResult } from "./runner.js";

/** Markdown summary for PR comments and CI step summaries. */
export function summaryMarkdown(s: RunSummary): string {
  const icon = (r: TestResult) => (r.status === "passed" ? "✅" : r.status === "failed" ? "❌" : "⏭️");
  const lines = [
    `### ${s.failed ? "❌" : "✅"} Memento: ${s.passed} passed, ${s.failed} failed${s.skipped ? `, ${s.skipped} skipped` : ""}`,
    "",
    "| | Test | Time | AI calls | Cache |",
    "| - | - | - | - | - |",
    ...s.results.map(
      (r) => `| ${icon(r)} | \`${r.file}\` | ${(r.durationMs / 1000).toFixed(1)}s | ${r.ai.calls} | ${r.cache.hits}/${r.cache.hits + r.cache.misses} |`,
    ),
  ];
  const failures = s.results.filter((r) => r.status === "failed");
  if (failures.length) {
    lines.push("", "<details><summary>Failures</summary>", "");
    for (const r of failures) {
      const step = flatten([...r.before, ...r.steps, ...r.after]).find((x) => x.status === "failed" || x.status === "softFailed");
      lines.push(`**${r.file}**${step ? ` — ${step.label}` : ""}`, "", "```", (step?.error ?? r.error ?? "failed").slice(0, 1500), "```", "");
    }
    lines.push("</details>");
  }
  return lines.join("\n") + "\n";
}

/** JUnit XML, understood by most CI systems. */
export function junitXml(s: RunSummary): string {
  const esc = (x: string) => x.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
  const cases = s.results
    .map((r) => {
      const t = (r.durationMs / 1000).toFixed(3);
      const body =
        r.status === "failed"
          ? `<failure message="${esc((r.error ?? "failed").split("\n")[0].slice(0, 300))}">${esc(r.error ?? "")}</failure>`
          : r.status === "skipped"
            ? "<skipped/>"
            : "";
      return `    <testcase classname="memento" name="${esc(r.file)}" time="${t}">${body}</testcase>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${s.results.length}" failures="${s.failed}" time="${(s.durationMs / 1000).toFixed(3)}">\n  <testsuite name="memento" tests="${s.results.length}" failures="${s.failed}" skipped="${s.skipped}">\n${cases}\n  </testsuite>\n</testsuites>\n`;
}
