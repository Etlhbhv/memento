import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeAI } from "../../core/test/fake-ai.js";
import { startServer, type StartedServer } from "../src/server.js";
import { githubRepoOf, prWorkflow } from "../src/github.js";

let s: StartedServer;
let project: string;
let ghMock: Server;
const pulls: string[] = [];
const fixtures = join(__dirname, "../../core/test/fixtures");

beforeAll(async () => {
  process.env.MEMENTO_HOME = mkdtempSync(join(tmpdir(), "memento-home-"));
  // Mock GitHub API: accepts token "good", rejects others.
  ghMock = createServer((req, res) => {
    const ok = req.headers.authorization === "Bearer good";
    res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
    const body =
      req.url === "/user" ? { login: "octo", avatar_url: "" }
      : req.url === "/repos/octo/app" ? { default_branch: "main", html_url: "https://github.com/octo/app" }
      : req.url === "/repos/octo/app/pulls" ? (pulls.push(req.method!), { html_url: "https://github.com/octo/app/pull/7", number: 7 })
      : [{ full_name: "octo/app", private: true, default_branch: "main", pushed_at: "2026-01-01T00:00:00Z", description: null }];
    res.end(JSON.stringify(ok ? body : { message: "Bad credentials" }));
  });
  await new Promise<void>((r) => ghMock.listen(0, "127.0.0.1", () => r()));
  process.env.MEMENTO_GITHUB_API = `http://127.0.0.1:${(ghMock.address() as { port: number }).port}`;

  project = mkdtempSync(join(tmpdir(), "memento-proj-"));
  cpSync(fixtures, join(project, "fixtures"), { recursive: true });
  mkdirSync(join(project, "memento"));
  writeFileSync(
    join(project, "memento/css.test.yaml"),
    `fileType: memento/test/v1\nid: css\nurl: file://${join(project, "fixtures/app.html")}\nsteps:\n  - click: { css: "#accept" }\n  - click: the Sign in button\n`,
  );
  writeFileSync(join(project, "memento/broken.test.yaml"), "fileType: memento/test/v1\nid: broken\nsteps:\n  - nope\n");
  s = await startServer({ ai: new FakeAI() });
});

afterAll(async () => {
  await s.close();
  ghMock.close();
});

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`http://127.0.0.1:${s.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

describe("security", () => {
  it("rejects requests without the token", async () => {
    const r = await fetch(`http://127.0.0.1:${s.port}/api/state`);
    expect(r.status).toBe(401);
  });
  it("rejects foreign Host headers (DNS rebinding)", async () => {
    const r = await new Promise<number>((resolve) => {
      const req = require("node:http").request(
        { host: "127.0.0.1", port: s.port, path: "/api/state", headers: { Host: "evil.example:80", Authorization: `Bearer ${s.token}` } },
        (res: { statusCode: number }) => resolve(res.statusCode),
      );
      req.end();
    });
    expect(r).toBe(403);
  });
  it("keeps file access inside the project", async () => {
    await call("POST", "/api/projects/open", { dir: project });
    const r = await call("GET", `/api/file?path=${encodeURIComponent("../../etc/passwd")}`);
    expect(r.status).toBe(403);
  });
});

describe("projects and files", () => {
  it("opens a project, creating a config, and lists tests including broken ones", async () => {
    const r = await call("POST", "/api/projects/open", { dir: project });
    expect(r.body.project).toBe(project);
    expect(readFileSync(join(project, "memento.config.yaml"), "utf8")).toContain("memento/**/*.test.yaml");
    const tests = await call("GET", "/api/tests");
    expect(tests.body.map((t: { id: string }) => t.id).sort()).toEqual(["broken", "css"]);
    expect(tests.body.find((t: { id: string }) => t.id === "broken").error).toMatch(/unknown command/);
  });

  it("validates and refuses to save invalid tests", async () => {
    const v = await call("POST", "/api/validate", { path: "memento/x.test.yaml", content: "fileType: memento/test/v1\nid: x\nsteps:\n  - refesh\n" });
    expect(v.body.error).toMatch(/unknown command/);
    const w = await call("PUT", "/api/file", { path: "memento/x.test.yaml", content: "fileType: nope\nid: x\n" });
    expect(w.status).toBe(500);
  });

  it("saves non-test files such as the PR workflow", async () => {
    const wf = await call("GET", "/api/github/workflow");
    const w = await call("PUT", "/api/file", wf.body);
    expect(w.status).toBe(200);
    expect(readFileSync(join(project, ".github/workflows/memento.yml"), "utf8")).toContain("Memento E2E");
  });

  it("saves AI settings into the config without touching other keys", async () => {
    await call("PUT", "/api/settings", { ai: { providers: { local: { type: "openai-compatible", baseURL: "http://localhost:11434/v1" } }, models: { default: "local:qwen" } } });
    const st = await call("GET", "/api/settings");
    expect(st.body.resolvedModels.locator).toBe("local:qwen");
    expect(readFileSync(join(project, "memento.config.yaml"), "utf8")).toContain("include:");
  });

  it("stores secrets outside the project", async () => {
    const r = await call("PUT", "/api/secrets", { name: "TEST_KEY", value: "s3cret" });
    expect(r.body.secrets).toContain("TEST_KEY");
    expect(readFileSync(join(process.env.MEMENTO_HOME!, "credentials.json"), "utf8")).toContain("s3cret");
    expect(readFileSync(join(project, "memento.config.yaml"), "utf8")).not.toContain("s3cret");
  });
});

describe("runs", () => {
  it("runs tests and streams events over SSE", async () => {
    const events: string[] = [];
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${s.port}/api/events?token=${s.token}`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const done = (async () => {
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        for (const m of buf.matchAll(/event: (\S+)/g)) events.push(m[1]);
        buf = "";
        if (events.includes("run:end")) break;
      }
    })();
    const r = await call("POST", "/api/runs", { paths: ["memento/css.test.yaml"] });
    expect(r.body.started).toBe(true);
    await done;
    ac.abort();
    expect(events).toEqual(expect.arrayContaining(["run:start", "test:start", "step:end", "test:end", "run:end"]));
    const runs = await call("GET", "/api/runs");
    expect(runs.body[0].passed).toBe(1);
    const detail = await call("GET", `/api/runs/${runs.body[0].runId}`);
    expect(detail.body.results[0].steps).toHaveLength(2);
  }, 60_000);
});

describe("AI test author", () => {
  it("drafts tests from the repository and repairs invalid YAML", async () => {
    const { body } = await call("POST", "/api/author", { maxTests: 5 });
    let job;
    for (let i = 0; i < 50; i++) {
      job = (await call("GET", `/api/author/${body.id}`)).body;
      if (job.status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(job.status).toBe("done");
    expect(job.result.tests).toHaveLength(2);
    expect(job.result.tests.every((t: { valid: boolean }) => t.valid)).toBe(true);
  });
});

describe("GitHub", () => {
  it("verifies tokens before saving them", async () => {
    const bad = await call("PUT", "/api/github/token", { token: "bad" });
    expect(bad.status).toBe(401);
    const good = await call("PUT", "/api/github/token", { token: "good" });
    expect(good.body).toEqual({ connected: true, login: "octo" });
    const repos = await call("GET", "/api/github/repos");
    expect(repos.body[0].fullName).toBe("octo/app");
  });

  it("detects the GitHub repo of a folder", async () => {
    const d = mkdtempSync(join(tmpdir(), "memento-git-"));
    execFileSync("git", ["init", "-q"], { cwd: d });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:octo/app.git"], { cwd: d });
    expect(await githubRepoOf(d)).toBe("octo/app");
  });

  it("commits tests on a branch, pushes and opens a pull request", async () => {
    // A local bare repo stands in for github.com; the GitHub API is mocked.
    const base = mkdtempSync(join(tmpdir(), "memento-pr-"));
    const bare = join(base, "remote.git");
    const work = join(base, "app");
    const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString();
    git(base, "init", "-q", "--bare", "-b", "main", bare);
    git(base, "clone", "-q", bare, work);
    writeFileSync(join(work, "README.md"), "# app\n");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "init", "--allow-empty");
    git(work, "add", ".");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "readme");
    git(work, "push", "-q", "origin", "main");
    // Make origin look like GitHub for repo detection, but push to the bare repo.
    git(work, "remote", "set-url", "origin", "https://github.com/octo/app.git");
    git(work, "config", "remote.origin.pushurl", bare);
    git(work, "config", `url.${bare}.insteadOf`, "https://github.com/octo/app.git");

    await call("POST", "/api/projects/open", { dir: work });
    const test = "fileType: memento/test/v1\nid: pr-test\nsteps:\n  - refresh\n";
    const r = await call("POST", "/api/github/pr", { files: [{ path: "memento/pr.test.yaml", content: test }], branch: "memento/new-tests" });
    expect(r.body.error ?? null).toBeNull();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ url: "https://github.com/octo/app/pull/7", branch: "memento/new-tests" });
    expect(pulls).toEqual(["POST"]);
    expect(git(bare, "show", "memento/new-tests:memento/pr.test.yaml")).toBe(test);
    expect(git(bare, "show", "memento/new-tests:memento.config.yaml")).toContain("include:");
    // The working copy is back on the default branch.
    expect(git(work, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    await call("POST", "/api/projects/open", { dir: project });
  });

  it("produces a PR workflow", () => {
    const wf = prWorkflow();
    expect(wf).toContain("pull_request");
    expect(wf).toContain("--summary-md");
  });
});
