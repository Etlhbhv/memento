#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { AGENTS, BrowserPool, loadConfig, ProviderAIClient, Runner, VERSION } from "@memento/core";
import { z } from "zod";
import { attachConsoleReporter, bold, dim, green, printSummary, red, yellow } from "./reporter.js";
import { CONFIG_TEMPLATE, EXAMPLE_KNOWLEDGE, EXAMPLE_MODULE, EXAMPLE_TEST } from "./templates.js";

const program = new Command();
program.name("memento").description("Open-source, bring-your-own-AI end-to-end testing").version(VERSION);

program
  .command("init")
  .description("Create memento.config.yaml and example tests in the current directory")
  .option("-f, --force", "overwrite existing files")
  .action((o: { force?: boolean }) => {
    const files: Record<string, string> = {
      "memento.config.yaml": CONFIG_TEMPLATE,
      "tests/example.test.yaml": EXAMPLE_TEST,
      "tests/modules/log-in.module.yaml": EXAMPLE_MODULE,
      ".memento/knowledge/project.yaml": EXAMPLE_KNOWLEDGE,
    };
    for (const [f, content] of Object.entries(files)) {
      if (existsSync(f) && !o.force) {
        console.log(yellow(`skip   ${f} (exists)`));
        continue;
      }
      mkdirSync(dirname(resolve(f)), { recursive: true });
      writeFileSync(f, content);
      console.log(green(`create ${f}`));
    }
    console.log(`\nNext: set an API key (e.g. ${bold("export ANTHROPIC_API_KEY=...")}) and run ${bold("memento run")}`);
  });

program
  .command("run")
  .description("Run tests")
  .argument("[paths...]", "test files or directories (default: config include globs)")
  .option("-c, --config <path>", "path to memento.config.yaml")
  .option("-e, --env <name>", "environment from the config")
  .option("-p, --parallel <n>", "number of tests to run at once", (v) => parseInt(v, 10))
  .option("-g, --grep <text>", "only tests whose id or path contains text")
  .option("-l, --label <labels...>", "only tests with one of these labels")
  .option("--headed", "show the browser")
  .option("--browser <type>", "chromium | firefox | webkit")
  .option("--no-cache", "ignore and don't write the step cache")
  .option("-m, --model <ref>", "override the default model, e.g. openai:gpt-5")
  .option("--retries <n>", "retry failed tests", (v) => parseInt(v, 10))
  .option("--var <kv...>", "set variables: --var EMAIL=a@b.c")
  .option("--json", "print the run summary as JSON")
  .option("-q, --quiet", "only print one line per test")
  .action(async (paths: string[], o) => {
    const cfg = loadConfig(o.config, {
      ...(o.browser ? { browser: { type: o.browser } } : {}),
      ...(o.retries !== undefined ? { retries: o.retries } : {}),
    } as never);
    if (o.model) cfg.ai.models = { ...cfg.ai.models, default: o.model };
    const runner = new Runner(cfg);
    if (!o.json) attachConsoleReporter(runner, { verbose: !o.quiet });
    const variables = Object.fromEntries((o.var ?? []).map((kv: string) => [kv.split("=")[0], kv.split("=").slice(1).join("=")]));
    const ac = new AbortController();
    process.once("SIGINT", () => {
      console.log(yellow("\nStopping after current steps…"));
      ac.abort();
    });
    try {
      const summary = await runner.run({
        paths,
        env: o.env,
        parallel: o.parallel,
        grep: o.grep,
        labels: o.label,
        headed: o.headed,
        disableCache: o.cache === false,
        variables,
        signal: ac.signal,
      });
      if (o.json) console.log(JSON.stringify(summary, null, 2));
      else printSummary(summary);
      process.exitCode = summary.failed > 0 ? 1 : summary.results.length === 0 ? 2 : 0;
    } catch (err) {
      console.error(red((err as Error).message));
      process.exitCode = 2;
    }
  });

program
  .command("list")
  .description("List discovered tests")
  .option("-c, --config <path>")
  .action((o) => {
    const cfg = loadConfig(o.config);
    for (const t of new Runner(cfg).discover()) {
      console.log(`${bold(t.id)}  ${dim(t.filePath.replace(cfg.rootDir + "/", ""))}${t.description ? `  ${t.description}` : ""}`);
    }
  });

program
  .command("trace")
  .description("Open a Playwright trace (time-travel debugger) from a run")
  .argument("<trace.zip>")
  .action((file: string) => {
    const require = createRequire(import.meta.url);
    const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
    spawn(process.execPath, [cli, "show-trace", file], { stdio: "inherit" });
  });

program
  .command("doctor")
  .description("Check configuration, browser and AI connectivity")
  .option("-c, --config <path>")
  .action(async (o) => {
    let ok = true;
    const check = async (name: string, fn: () => Promise<string | void>) => {
      try {
        const note = await fn();
        console.log(`${green("✓")} ${name}${note ? dim(`  ${note}`) : ""}`);
      } catch (e) {
        ok = false;
        console.log(`${red("✘")} ${name}\n    ${red((e as Error).message.split("\n").join("\n    "))}`);
      }
    };
    const cfg = loadConfig(o.config);
    await check("config", async () => cfg.configPath ?? "no memento.config.yaml found (using defaults)");
    await check(`browser (${cfg.browser.type})`, async () => {
      const pool = new BrowserPool(cfg.browser);
      const b = await pool.get();
      const v = b.version();
      await pool.close();
      return v;
    });
    await check("tests", async () => `${new Runner(cfg).discover().length} found`);
    const ai = new ProviderAIClient(cfg.ai);
    const seen = new Set<string>();
    for (const agent of AGENTS) {
      const model = ai.modelFor(agent);
      if (seen.has(model)) continue;
      seen.add(model);
      await check(`model for ${agent}: ${model}`, async () => {
        const r = await ai.generate({
          agent,
          system: "Reply with JSON.",
          content: [{ type: "text", text: 'Return {"ok": true}.' }],
          schema: z.object({ ok: z.boolean() }),
        });
        return `${r.durationMs}ms`;
      });
    }
    process.exitCode = ok ? 0 : 1;
  });

program.parseAsync().catch((e) => {
  console.error(red(e.message));
  process.exit(2);
});
