import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { loadConfig, parseFile, Runner, type RunSummary } from "@memento/core";
import { loadSecrets, saveSecret, secretNames } from "./secrets.js";

const here = dirname(fileURLToPath(import.meta.url));
let win: BrowserWindow | null = null;
let projectDir: string | null = null;
let currentRun: AbortController | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Memento",
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(join(here, "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());

// ---------------------------------------------------------------- helpers

function requireProject(): string {
  if (!projectDir) throw new Error("No project open");
  return projectDir;
}

/** Only allow reading/writing files inside the open project. */
function inProject(p: string): string {
  const root = requireProject();
  const abs = resolve(root, p);
  if (relative(root, abs).startsWith("..")) throw new Error("Path is outside the project");
  return abs;
}

function configPath(root: string) {
  return join(root, "memento.config.yaml");
}

// ---------------------------------------------------------------- IPC

ipcMain.handle("app:initialProject", () => process.env.MEMENTO_PROJECT ?? null);

ipcMain.handle("project:open", async (_e, dir?: string) => {
  if (!dir) {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"] });
    if (r.canceled || !r.filePaths[0]) return null;
    dir = r.filePaths[0];
  }
  projectDir = dir;
  if (!existsSync(configPath(dir))) {
    writeFileSync(configPath(dir), `name: ${JSON.stringify(dir.split(/[\\/]/).pop())}\ninclude: ["**/*.test.yaml"]\n`);
  }
  return { dir };
});

ipcMain.handle("tests:list", () => {
  const cfg = loadConfig(requireProject());
  return new Runner(cfg).discover().map((t) => ({
    id: t.id,
    description: t.description,
    file: relative(cfg.rootDir, t.filePath),
    steps: t.steps.length,
  }));
});

ipcMain.handle("file:read", (_e, p: string) => readFileSync(inProject(p), "utf8"));

ipcMain.handle("file:write", (_e, p: string, content: string) => {
  const abs = inProject(p);
  // Validate before saving so the editor shows format errors immediately.
  parseFile(abs, content);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return true;
});

ipcMain.handle("file:validate", (_e, p: string, content: string) => {
  try {
    parseFile(inProject(p), content);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
});

ipcMain.handle("settings:get", () => {
  const root = requireProject();
  const doc = parseDocument(readFileSync(configPath(root), "utf8"));
  const ai = (doc.toJS() as { ai?: unknown })?.ai ?? {};
  return { ai, secrets: secretNames() };
});

/** Update the `ai` block in memento.config.yaml, preserving comments elsewhere. */
ipcMain.handle("settings:saveAi", (_e, ai: Record<string, unknown>) => {
  const root = requireProject();
  const doc = parseDocument(readFileSync(configPath(root), "utf8"));
  doc.set("ai", doc.createNode(ai));
  writeFileSync(configPath(root), doc.toString());
  return true;
});

ipcMain.handle("secrets:set", (_e, name: string, value: string | null) => {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error("Secret names must look like ENV_VARS");
  saveSecret(name, value);
  return secretNames();
});

ipcMain.handle("run:start", async (e, opts: { paths?: string[]; headed?: boolean; disableCache?: boolean; env?: string }) => {
  const root = requireProject();
  if (currentRun) throw new Error("A run is already in progress");
  // Inject keychain secrets as env vars for `${VAR}` expansion in the config.
  Object.assign(process.env, loadSecrets());
  const cfg = loadConfig(root);
  const runner = new Runner(cfg);
  const send = (channel: string, payload: unknown) => {
    if (!e.sender.isDestroyed()) e.sender.send("run:event", { channel, payload: JSON.parse(JSON.stringify(payload)) });
  };
  runner.on("run:start", (p) => send("run:start", { runId: p.runId, tests: p.tests.map((t) => ({ id: t.id, file: relative(root, t.filePath) })) }));
  runner.on("test:start", (p) => send("test:start", p));
  runner.on("step:start", (p) => send("step:start", p));
  runner.on("step:end", (p) => send("step:end", p));
  runner.on("test:end", (p) => send("test:end", p));
  runner.on("log", (p) => send("log", p));
  currentRun = new AbortController();
  try {
    const summary: RunSummary = await runner.run({
      paths: opts.paths?.map((p) => inProject(p)),
      headed: opts.headed,
      disableCache: opts.disableCache,
      env: opts.env,
      signal: currentRun.signal,
    });
    send("run:end", summary);
    return { passed: summary.passed, failed: summary.failed };
  } catch (err) {
    send("run:error", { message: (err as Error).message });
    throw err;
  } finally {
    currentRun = null;
  }
});

ipcMain.handle("run:stop", () => {
  currentRun?.abort();
  return true;
});

ipcMain.handle("trace:open", (_e, tracePath: string) => {
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
  spawn(process.execPath, [cli, "show-trace", tracePath], { stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  return true;
});

ipcMain.handle("shell:reveal", (_e, p: string) => shell.showItemInFolder(p));
