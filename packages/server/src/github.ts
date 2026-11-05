import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { mementoHome, readCredentials, writeCredentials } from "./store.js";

const run = promisify(execFile);

/**
 * GitHub integration for a local-first tool.
 *
 * Auth, in order: a token saved through the UI, `gh auth token` (if the
 * GitHub CLI is logged in), or GITHUB_TOKEN. A fine-grained token needs
 * Contents (read/write), Pull requests (read/write) and Workflows (write, to
 * add the PR workflow) on the chosen repositories.
 *
 * The token is never written into git remotes or config: git commands get it
 * through a one-off `http.extraheader`.
 */
export class GitHubError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "GitHubError";
  }
}

export async function resolveToken(): Promise<{ token: string; source: "saved" | "gh" | "env" } | null> {
  const saved = readCredentials().githubToken;
  if (saved) return { token: saved, source: "saved" };
  try {
    const { stdout } = await run("gh", ["auth", "token"], { timeout: 5000 });
    if (stdout.trim()) return { token: stdout.trim(), source: "gh" };
  } catch {}
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, source: "env" };
  return null;
}

export function saveToken(token: string | null): void {
  const c = readCredentials();
  if (token) c.githubToken = token;
  else delete c.githubToken;
  writeCredentials(c);
}

export class GitHub {
  constructor(
    private readonly token: string,
    private readonly api = process.env.MEMENTO_GITHUB_API ?? "https://api.github.com",
  ) {}

  static async connect(): Promise<GitHub | null> {
    const t = await resolveToken();
    return t ? new GitHub(t.token) : null;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "memento-testing",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const j = (await res.json()) as { message?: string };
        if (j.message) msg = `${j.message} (${res.status})`;
      } catch {}
      throw new GitHubError(`GitHub ${method} ${path}: ${msg}`, res.status);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  user() {
    return this.request<{ login: string; name: string | null; avatar_url: string }>("GET", "/user");
  }

  async repos(): Promise<Array<{ fullName: string; private: boolean; defaultBranch: string; pushedAt: string; description: string | null }>> {
    const out: Array<{ fullName: string; private: boolean; defaultBranch: string; pushedAt: string; description: string | null }> = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.request<Array<{ full_name: string; private: boolean; default_branch: string; pushed_at: string; description: string | null }>>(
        "GET",
        `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
      );
      out.push(...batch.map((r) => ({ fullName: r.full_name, private: r.private, defaultBranch: r.default_branch, pushedAt: r.pushed_at, description: r.description })));
      if (batch.length < 100) break;
    }
    return out;
  }

  repo(fullName: string) {
    return this.request<{ default_branch: string; html_url: string; permissions?: { push: boolean } }>("GET", `/repos/${fullName}`);
  }

  async openPullRequest(fullName: string, p: { head: string; base: string; title: string; body: string }) {
    const pr = await this.request<{ html_url: string; number: number }>("POST", `/repos/${fullName}/pulls`, p);
    return { url: pr.html_url, number: pr.number };
  }

  /** git with the token injected for this command only. */
  async git(cwd: string, args: string[]) {
    const basic = Buffer.from(`x-access-token:${this.token}`).toString("base64");
    return run("git", ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`, ...args], {
      cwd,
      timeout: 5 * 60_000,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  }

  /** Clone (or update) a repository into ~/.memento/repos/<owner>/<name>. */
  async cloneOrPull(fullName: string): Promise<string> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw new GitHubError(`Invalid repository name ${fullName}`);
    const dir = join(mementoHome(), "repos", ...fullName.split("/"));
    if (existsSync(join(dir, ".git"))) {
      await this.git(dir, ["fetch", "--depth", "50", "origin"]).catch(() => {});
      // Only fast-forward; never discard the user's local edits.
      await this.git(dir, ["pull", "--ff-only"]).catch(() => {});
    } else {
      mkdirSync(dirname(dir), { recursive: true });
      await this.git(dirname(dir), ["clone", "--depth", "50", `https://github.com/${fullName}.git`, dir]);
    }
    return dir;
  }

  /**
   * Write files on a new branch from the default branch, commit, push and
   * open a pull request. Leaves the working copy on the default branch.
   */
  async proposeFiles(
    repoDir: string,
    fullName: string,
    p: { files: Array<{ path: string; content: string }>; branch: string; title: string; body: string },
  ): Promise<{ url: string; number: number; branch: string }> {
    if (!/^[\w./-]+$/.test(p.branch) || p.branch.includes("..")) throw new GitHubError("Invalid branch name");
    const info = await this.repo(fullName);
    const base = info.default_branch;
    const { stdout: status } = await run("git", ["status", "--porcelain"], { cwd: repoDir });
    const dirtyOutside = status
      .split("\n")
      .filter((l) => l && !l.startsWith("??")) // untracked files don't interfere
      .map((l) => l.slice(3))
      .filter((f) => !p.files.some((x) => x.path === f));
    if (dirtyOutside.length) throw new GitHubError(`The local copy has other uncommitted changes: ${dirtyOutside.slice(0, 5).join(", ")}`);

    await this.git(repoDir, ["fetch", "--depth", "50", "origin", base]);
    await this.git(repoDir, ["checkout", "-B", p.branch, `origin/${base}`]);
    try {
      for (const f of p.files) {
        const abs = resolve(repoDir, f.path);
        if (relative(repoDir, abs).startsWith("..")) throw new GitHubError(`Path outside repository: ${f.path}`);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.content);
      }
      await this.git(repoDir, ["add", "--", ...p.files.map((f) => f.path)]);
      await this.git(repoDir, [
        "-c", "user.name=Memento",
        "-c", "user.email=memento@users.noreply.github.com",
        "commit", "-m", p.title, "-m", p.body,
      ]);
      await this.git(repoDir, ["push", "-u", "origin", p.branch]);
      const pr = await this.openPullRequest(fullName, { head: p.branch, base, title: p.title, body: p.body });
      return { ...pr, branch: p.branch };
    } finally {
      await this.git(repoDir, ["checkout", base]).catch(() => {});
    }
  }
}

/** The repository (owner/name) a local folder's `origin` points to, if it is on GitHub. */
export async function githubRepoOf(dir: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["config", "--get", "remote.origin.url"], { cwd: dir, timeout: 5000 });
    const m = stdout.trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** GitHub Actions workflow that runs the suite on every pull request and comments the result. */
export function prWorkflow(opts: { testsGlob?: string } = {}): string {
  return `# Added by Memento. Runs end-to-end tests on every pull request.
# Required: an AI key secret (e.g. ANTHROPIC_API_KEY) and a URL the tests can reach:
#   Settings → Secrets and variables → Actions → New repository secret / variable
#   - secret ANTHROPIC_API_KEY (or OPENAI_API_KEY, OPENROUTER_API_KEY, ...)
#   - variable MEMENTO_BASE_URL, e.g. your preview deployment or staging URL
name: Memento E2E

on:
  pull_request:
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write

jobs:
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install Memento
        run: |
          git clone --depth 1 https://github.com/Etlhbhv/memento.git "$RUNNER_TEMP/memento"
          cd "$RUNNER_TEMP/memento"
          corepack enable
          pnpm install --frozen-lockfile
          pnpm --filter "@memento/cli..." build
          npx playwright install --with-deps chromium

      - name: Run tests
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
          OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}
          MEMENTO_BASE_URL: \${{ vars.MEMENTO_BASE_URL }}
        run: node "$RUNNER_TEMP/memento/packages/cli/dist/bin.js" run ${opts.testsGlob ?? ""} --summary-md memento-summary.md

      - name: Comment results on the pull request
        if: always() && github.event_name == 'pull_request' && hashFiles('memento-summary.md') != ''
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          cat memento-summary.md >> "$GITHUB_STEP_SUMMARY"
          gh pr comment \${{ github.event.pull_request.number }} --body-file memento-summary.md --edit-last || \\
          gh pr comment \${{ github.event.pull_request.number }} --body-file memento-summary.md

      - name: Upload traces
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: memento-results
          path: memento-results/
`;
}
