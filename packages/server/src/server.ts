import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import {
  AGENTS,
  authorTests,
  loadConfig,
  parseFile,
  ProviderAIClient,
  Runner,
  type AIClient,
  type MementoConfig,
  type RunSummary,
} from "@memento/core";
import { GitHub, GitHubError, githubRepoOf, prWorkflow, resolveToken, saveToken } from "./github.js";
import { applySecretsToEnv, readCredentials, readState, rememberProject, setSecret } from "./store.js";

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Directory with the built web UI (index.html + assets). */
  webDir?: string;
  /** Project to open on start. */
  project?: string;
  /** Inject an AI client (tests). */
  ai?: AIClient;
  token?: string;
}

export interface StartedServer {
  url: string;
  token: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webm": "video/webm", ".json": "application/json",
  ".woff2": "font/woff2", ".ico": "image/x-icon", ".zip": "application/zip",
};

const CONFIG_STARTER = (name: string) => `# Memento project configuration
name: ${JSON.stringify(name)}
baseUrl: \${MEMENTO_BASE_URL:-http://localhost:3000}
include: ["memento/**/*.test.yaml", "tests/**/*.test.yaml"]

ai:
  providers:
    anthropic:
      type: anthropic
      apiKey: \${ANTHROPIC_API_KEY}
  models:
    default: anthropic:claude-sonnet-5-5
`;

/**
 * Local Memento server: the web UI plus a JSON API over the core library.
 * Binds to 127.0.0.1 and requires a per-launch token, and checks the Host
 * header so other websites can't drive it (DNS rebinding / CSRF).
 */
export async function startServer(opts: ServerOptions = {}): Promise<StartedServer> {
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const host = opts.host ?? "127.0.0.1";
  applySecretsToEnv();

  let projectDir: string | null = null;
  let run: { abort: AbortController; runId?: string } | null = null;
  const authorJobs = new Map<string, { status: "running" | "done" | "failed"; result?: unknown; error?: string }>();
  const clients = new Set<ServerResponse>();

  const broadcast = (type: string, payload: unknown) => {
    const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of clients) c.write(data);
  };

  const openProject = (dir: string) => {
    const abs = resolve(dir.replace(/^~(?=$|\/)/, homedir()));
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new HttpError(400, `Not a folder: ${abs}`);
    if (!existsSync(join(abs, "memento.config.yaml")) && !existsSync(join(abs, "memento.config.yml"))) {
      writeFileSync(join(abs, "memento.config.yaml"), CONFIG_STARTER(abs.split(sep).pop() ?? "project"));
    }
    projectDir = abs;
    rememberProject(abs);
    return abs;
  };
  if (opts.project) openProject(opts.project);

  const project = () => {
    if (!projectDir) throw new HttpError(409, "No project open");
    return projectDir;
  };
  const config = (): MementoConfig => {
    applySecretsToEnv();
    return loadConfig(project());
  };
  const inProject = (p: string) => {
    const root = project();
    const abs = resolve(root, p);
    if (abs !== root && relative(root, abs).startsWith("..")) throw new HttpError(403, "Path is outside the project");
    return abs;
  };
  const aiClient = (cfg: MementoConfig) => opts.ai ?? new ProviderAIClient(cfg.ai);

  // ---------------------------------------------------------------- routes
  type Handler = (req: IncomingMessage, body: any, url: URL) => Promise<unknown> | unknown;
  const routes: Array<[string, RegExp, Handler]> = [];
  const route = (method: string, path: string, h: Handler) => routes.push([method, new RegExp(`^${path}$`), h]);

  route("GET", "/api/state", async () => {
    const gh = await resolveToken();
    return {
      project: projectDir,
      projectRepo: projectDir ? await githubRepoOf(projectDir) : null,
      recentProjects: readState().recentProjects.filter((d) => existsSync(d)),
      github: gh ? { connected: true, source: gh.source } : { connected: false },
      running: !!run,
      home: homedir(),
    };
  });

  route("POST", "/api/projects/open", (_r, b) => ({ project: openProject(String(b.dir ?? "")) }));

  route("GET", "/api/fs", (_r, _b, url) => {
    const dir = resolve((url.searchParams.get("dir") || homedir()).replace(/^~(?=$|\/)/, homedir()));
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    return { dir, parent: dirname(dir) === dir ? null : dirname(dir), entries, isProject: existsSync(join(dir, "memento.config.yaml")) };
  });

  route("GET", "/api/tests", () => {
    const cfg = config();
    return new Runner(cfg).discoverWithErrors().map((t) => ({
      ...t,
      file: relative(cfg.rootDir, t.filePath),
    }));
  });

  route("GET", "/api/file", (_r, _b, url) => ({ content: readFileSync(inProject(url.searchParams.get("path") ?? ""), "utf8") }));

  route("PUT", "/api/file", (_r, b) => {
    const abs = inProject(String(b.path));
    if (/\.(test|module)\.ya?ml$/.test(abs)) parseFile(abs, String(b.content));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, String(b.content));
    return { ok: true };
  });

  route("DELETE", "/api/file", (_r, _b, url) => {
    const abs = inProject(url.searchParams.get("path") ?? "");
    if (!/\.(test|module)\.ya?ml$/.test(abs)) throw new HttpError(400, "Only test and module files can be deleted here");
    rmSync(abs);
    return { ok: true };
  });

  route("POST", "/api/validate", (_r, b) => {
    try {
      parseFile(inProject(String(b.path)), String(b.content));
      return { error: null };
    } catch (e) {
      return { error: (e as Error).message.replace(/^[^:]*: /, "") };
    }
  });

  route("GET", "/api/settings", () => {
    const cfg = config();
    const raw = parseDocument(readFileSync(cfg.configPath!, "utf8")).toJS() ?? {};
    return {
      ai: raw.ai ?? {},
      resolvedModels: Object.fromEntries(AGENTS.map((a) => [a, new ProviderAIClient(cfg.ai).modelFor(a)])),
      baseUrl: raw.baseUrl ?? null,
      environments: cfg.environments.map((e) => e.name),
      secrets: Object.keys(readCredentials().secrets),
    };
  });

  route("PUT", "/api/settings", (_r, b) => {
    const cfg = config();
    const doc = parseDocument(readFileSync(cfg.configPath!, "utf8"));
    if (b.ai !== undefined) doc.set("ai", doc.createNode(b.ai));
    if (b.baseUrl !== undefined) doc.set("baseUrl", b.baseUrl);
    writeFileSync(cfg.configPath!, doc.toString());
    loadConfig(project()); // validate
    return { ok: true };
  });

  route("PUT", "/api/secrets", (_r, b) => {
    const name = String(b.name ?? "");
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new HttpError(400, "Secret names must look like ENV_VARS");
    setSecret(name, b.value ? String(b.value) : null);
    if (b.value) process.env[name] = String(b.value);
    else delete process.env[name];
    return { secrets: Object.keys(readCredentials().secrets) };
  });

  route("POST", "/api/runs", (_r, b) => {
    if (run) throw new HttpError(409, "A run is already in progress");
    const cfg = config();
    const runner = new Runner(cfg);
    const root = project();
    runner.on("run:start", (p) => {
      if (run) run.runId = p.runId;
      broadcast("run:start", { runId: p.runId, tests: p.tests.map((t) => ({ id: t.id, file: relative(root, t.filePath) })) });
    });
    runner.on("test:start", (p) => broadcast("test:start", p));
    runner.on("step:start", (p) => broadcast("step:start", p));
    runner.on("step:end", (p) => broadcast("step:end", p));
    runner.on("test:end", (p) => broadcast("test:end", p));
    run = { abort: new AbortController() };
    const signal = run.abort.signal;
    runner
      .run({
        paths: Array.isArray(b.paths) ? b.paths.map((p: string) => inProject(p)) : undefined,
        headed: !!b.headed,
        disableCache: !!b.disableCache,
        env: b.env || undefined,
        ai: opts.ai,
        signal,
      })
      .then((summary: RunSummary) => broadcast("run:end", summary))
      .catch((e: Error) => broadcast("run:error", { message: e.message }))
      .finally(() => (run = null));
    return { started: true };
  });

  route("POST", "/api/runs/stop", () => {
    run?.abort.abort();
    return { ok: true };
  });

  route("GET", "/api/runs", () => {
    const cfg = config();
    const dir = resolve(cfg.rootDir, cfg.outputDir);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((d) => existsSync(join(dir, d, "summary.json")))
      .sort()
      .reverse()
      .slice(0, 50)
      .map((d) => {
        const s = JSON.parse(readFileSync(join(dir, d, "summary.json"), "utf8")) as RunSummary;
        return { runId: s.runId, startedAt: s.startedAt, durationMs: s.durationMs, passed: s.passed, failed: s.failed, skipped: s.skipped, tests: s.results.length };
      });
  });

  route("GET", "/api/runs/(?<id>[\\w-]+)", (_r, _b, url) => {
    const cfg = config();
    const id = url.pathname.split("/").pop()!;
    const f = resolve(cfg.rootDir, cfg.outputDir, id, "summary.json");
    if (!existsSync(f)) throw new HttpError(404, "Run not found");
    return JSON.parse(readFileSync(f, "utf8"));
  });

  route("POST", "/api/trace/open", (_r, b) => {
    const p = inProject(relative(project(), String(b.path)));
    const require = createRequire(import.meta.url);
    const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
    spawn(process.execPath, [cli, "show-trace", p], { stdio: "ignore", detached: true }).unref();
    return { ok: true };
  });

  // ------------------------------------------------------------ GitHub
  route("GET", "/api/github", async () => {
    const t = await resolveToken();
    if (!t) return { connected: false };
    try {
      const user = await new GitHub(t.token).user();
      return { connected: true, source: t.source, login: user.login, avatar: user.avatar_url };
    } catch (e) {
      return { connected: false, error: (e as Error).message, source: t.source };
    }
  });

  route("PUT", "/api/github/token", async (_r, b) => {
    const token = String(b.token ?? "").trim();
    if (!token) {
      saveToken(null);
      return { connected: false };
    }
    const user = await new GitHub(token).user(); // verify before saving
    saveToken(token);
    return { connected: true, login: user.login };
  });

  const gh = async () => {
    const g = await GitHub.connect();
    if (!g) throw new HttpError(401, "GitHub is not connected");
    return g;
  };

  route("GET", "/api/github/repos", async () => (await gh()).repos());

  route("POST", "/api/github/clone", async (_r, b) => {
    const dir = await (await gh()).cloneOrPull(String(b.repo));
    return { project: openProject(dir) };
  });

  route("POST", "/api/author", (_r, b) => {
    const cfg = config();
    const id = randomBytes(6).toString("hex");
    authorJobs.set(id, { status: "running" });
    authorTests(aiClient(cfg), {
      repoDir: project(),
      request: b.request ? String(b.request) : undefined,
      maxTests: Math.min(Number(b.maxTests) || 5, 15),
      baseUrl: cfg.baseUrl,
    })
      .then((result) => {
        authorJobs.set(id, { status: "done", result });
        broadcast("author:done", { id, result });
      })
      .catch((e: Error) => {
        authorJobs.set(id, { status: "failed", error: e.message });
        broadcast("author:failed", { id, error: e.message });
      });
    return { id };
  });

  route("GET", "/api/author/(?<id>\\w+)", (_r, _b, url) => {
    const job = authorJobs.get(url.pathname.split("/").pop()!);
    if (!job) throw new HttpError(404, "Unknown job");
    return job;
  });

  route("GET", "/api/github/workflow", () => ({ path: ".github/workflows/memento.yml", content: prWorkflow() }));

  route("POST", "/api/github/pr", async (_r, b) => {
    const root = project();
    const repo = await githubRepoOf(root);
    if (!repo) throw new HttpError(400, "This project is not a GitHub repository (no github.com origin remote)");
    const files = (b.files as Array<{ path: string; content: string }>).map((f) => {
      const rel = relative(root, inProject(f.path));
      if (/\.test\.ya?ml$/.test(rel)) parseFile(join(root, rel), f.content);
      return { path: rel.split(sep).join("/"), content: f.content };
    });
    if (!files.length) throw new HttpError(400, "Nothing to commit");
    // Include the project config if the repository doesn't track one yet.
    const cfgFile = "memento.config.yaml";
    if (!files.some((f) => f.path === cfgFile) && existsSync(join(root, cfgFile)) && !(await isTracked(root, cfgFile))) {
      files.push({ path: cfgFile, content: readFileSync(join(root, cfgFile), "utf8") });
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    return (await gh()).proposeFiles(root, repo, {
      files,
      branch: String(b.branch || `memento/tests-${stamp}`),
      title: String(b.title || "Add Memento end-to-end tests"),
      body: String(
        b.body ||
          `This PR adds end-to-end tests written with [Memento](https://github.com/Etlhbhv/memento).\n\n${files.map((f) => `- \`${f.path}\``).join("\n")}\n\nTests are plain YAML: review them like code.`,
      ),
    });
  });

  // ------------------------------------------------------------ server
  const webDir = opts.webDir;
  const expectedHosts = new Set<string>();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      // DNS-rebinding protection: only accept our own host names.
      if (!expectedHosts.has(req.headers.host ?? "")) throw new HttpError(403, "Bad host");

      if (!url.pathname.startsWith("/api/")) return serveStatic(webDir, url.pathname, res);

      const provided = url.pathname === "/api/events" || url.pathname === "/api/artifact" ? url.searchParams.get("token") : bearer(req);
      if (!provided || !safeEqual(provided, token)) throw new HttpError(401, "Missing or invalid token");

      if (url.pathname === "/api/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": connected\n\n");
        clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 20000);
        req.on("close", () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
      if (url.pathname === "/api/artifact") {
        // Screenshots, videos and traces from the project's results folder only.
        const cfg = config();
        const resultsDir = resolve(cfg.rootDir, cfg.outputDir);
        const p = resolve(url.searchParams.get("path") ?? "");
        if (relative(resultsDir, p).startsWith("..") || !existsSync(p)) throw new HttpError(404, "Not found");
        res.writeHead(200, { "Content-Type": MIME[extname(p)] ?? "application/octet-stream" });
        createReadStream(p).pipe(res);
        return;
      }

      const match = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
      if (!match) throw new HttpError(404, `No route ${req.method} ${url.pathname}`);
      if (req.method !== "GET" && req.headers["content-type"] && !String(req.headers["content-type"]).includes("application/json")) {
        throw new HttpError(415, "Use application/json");
      }
      const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req);
      const out = await match[2](req, body, url);
      json(res, 200, out ?? { ok: true });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof GitHubError ? (e.status === 401 ? 401 : 502) : 500;
      if (!res.headersSent) json(res, status, { error: (e as Error).message });
      else res.end();
    }
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? 0, host, () => ok());
  });
  const port = (server.address() as { port: number }).port;
  for (const h of ["127.0.0.1", "localhost", host]) expectedHosts.add(`${h}:${port}`);
  return {
    url: `http://127.0.0.1:${port}/#token=${token}`,
    token,
    port,
    server,
    close: () =>
      new Promise((ok) => {
        run?.abort.abort();
        for (const c of clients) c.end();
        server.close(() => ok());
      }),
  };
}

async function isTracked(dir: string, file: string): Promise<boolean> {
  return new Promise((ok) => {
    const p = spawn("git", ["ls-files", "--error-unmatch", file], { cwd: dir, stdio: "ignore" });
    p.on("exit", (code) => ok(code === 0));
    p.on("error", () => ok(false));
  });
}

function serveStatic(webDir: string | undefined, pathname: string, res: ServerResponse) {
  if (!webDir || !existsSync(webDir)) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Memento server is running, but the web UI is not built. Run `pnpm build`.");
    return;
  }
  let file = resolve(webDir, "." + decodeURIComponent(pathname));
  if (relative(webDir, file).startsWith("..")) file = join(webDir, "index.html");
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(webDir, "index.html"); // SPA fallback
  res.writeHead(200, {
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    "Cache-Control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  createReadStream(file).pipe(res);
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function bearer(req: IncomingMessage) {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 10 * 1024 * 1024) throw new HttpError(413, "Body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}
