// Thin client for the local Memento server. The launch token arrives in the
// URL hash (#token=…) and is kept in sessionStorage, never sent to other hosts.

const hashToken = new URLSearchParams(location.hash.slice(1)).get("token");
if (hashToken) {
  sessionStorage.setItem("memento-token", hashToken);
  history.replaceState(null, "", location.pathname + location.search);
}
export const token = sessionStorage.getItem("memento-token") ?? "";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? res.statusText, res.status);
  return data as T;
}

export const artifactUrl = (path: string) => `/api/artifact?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`;

// ----------------------------------------------------------------- types
export interface AppState {
  project: string | null;
  projectRepo: string | null;
  recentProjects: string[];
  github: { connected: boolean; source?: string };
  running: boolean;
  home: string;
}
export interface TestInfo {
  id: string;
  file: string;
  description?: string;
  labels?: string[];
  steps: number;
  error?: string;
}
export interface AICall { agent: string; model: string; durationMs: number; inputTokens: number; outputTokens: number }
export interface StepResult {
  path: string;
  label: string;
  cmd: string;
  status: "passed" | "failed" | "skipped" | "softFailed";
  durationMs: number;
  error?: string;
  resolution?: "cache" | "ai" | "healed";
  reasoning?: string;
  ai: AICall[];
  screenshot?: string;
  recovered?: boolean;
  children?: StepResult[];
}
export interface TestResult {
  testId: string;
  file: string;
  description?: string;
  status: "passed" | "failed" | "skipped";
  attempt: number;
  durationMs: number;
  error?: string;
  before: StepResult[];
  steps: StepResult[];
  after: StepResult[];
  cache: { hits: number; misses: number; healed: number };
  ai: { calls: number; inputTokens: number; outputTokens: number; models: string[] };
  trace?: string;
  video?: string;
}
export interface RunSummary {
  runId: string;
  startedAt: number;
  durationMs: number;
  passed: number;
  failed: number;
  skipped: number;
  results: TestResult[];
}
export interface RunListItem { runId: string; startedAt: number; durationMs: number; passed: number; failed: number; skipped: number; tests: number }
export interface Provider { type: "anthropic" | "openai" | "google" | "openai-compatible"; apiKey?: string; baseURL?: string; vision?: boolean }
export interface AiSettings {
  providers?: Record<string, Provider>;
  models?: Record<string, string | string[]>;
  vision?: boolean;
  failureRecovery?: boolean;
  [k: string]: unknown;
}
export interface Settings { ai: AiSettings; resolvedModels: Record<string, string>; baseUrl: string | null; environments: string[]; secrets: string[] }
export interface Repo { fullName: string; private: boolean; defaultBranch: string; pushedAt: string; description: string | null }
export interface DraftTest { fileName: string; yaml: string; rationale: string; variables: string[]; valid: boolean; error?: string }
export interface AuthorResult { analysis: string; tests: DraftTest[]; model: string; usage: { inputTokens: number; outputTokens: number } }

// ----------------------------------------------------------------- calls
export const api = {
  state: () => call<AppState>("GET", "/api/state"),
  openProject: (dir: string) => call<{ project: string }>("POST", "/api/projects/open", { dir }),
  fs: (dir?: string) => call<{ dir: string; parent: string | null; entries: string[]; isProject: boolean }>("GET", `/api/fs${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`),
  tests: () => call<TestInfo[]>("GET", "/api/tests"),
  readFile: (path: string) => call<{ content: string }>("GET", `/api/file?path=${encodeURIComponent(path)}`).then((r) => r.content),
  writeFile: (path: string, content: string) => call("PUT", "/api/file", { path, content }),
  deleteFile: (path: string) => call("DELETE", `/api/file?path=${encodeURIComponent(path)}`),
  validate: (path: string, content: string) => call<{ error: string | null }>("POST", "/api/validate", { path, content }).then((r) => r.error),
  settings: () => call<Settings>("GET", "/api/settings"),
  saveSettings: (s: { ai?: AiSettings; baseUrl?: string | null }) => call("PUT", "/api/settings", s),
  setSecret: (name: string, value: string | null) => call<{ secrets: string[] }>("PUT", "/api/secrets", { name, value }),
  startRun: (o: { paths?: string[]; headed?: boolean; disableCache?: boolean; env?: string }) => call("POST", "/api/runs", o),
  stopRun: () => call("POST", "/api/runs/stop"),
  runs: () => call<RunListItem[]>("GET", "/api/runs"),
  run: (id: string) => call<RunSummary>("GET", `/api/runs/${id}`),
  openTrace: (path: string) => call("POST", "/api/trace/open", { path }),
  github: () => call<{ connected: boolean; login?: string; avatar?: string; source?: string; error?: string }>("GET", "/api/github"),
  setGithubToken: (token: string | null) => call<{ connected: boolean; login?: string }>("PUT", "/api/github/token", { token }),
  repos: () => call<Repo[]>("GET", "/api/github/repos"),
  clone: (repo: string) => call<{ project: string }>("POST", "/api/github/clone", { repo }),
  author: (o: { request?: string; maxTests?: number }) => call<{ id: string }>("POST", "/api/author", o),
  authorJob: (id: string) => call<{ status: "running" | "done" | "failed"; result?: AuthorResult; error?: string }>("GET", `/api/author/${id}`),
  workflow: () => call<{ path: string; content: string }>("GET", "/api/github/workflow"),
  openPr: (o: { files: Array<{ path: string; content: string }>; title?: string; body?: string; branch?: string }) =>
    call<{ url: string; number: number; branch: string }>("POST", "/api/github/pr", o),
};

/** Server-sent events (run progress, author jobs). */
export function subscribe(onEvent: (type: string, payload: any) => void): () => void {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  const types = ["run:start", "test:start", "step:start", "step:end", "test:end", "run:end", "run:error", "author:done", "author:failed"];
  for (const t of types) es.addEventListener(t, (e) => onEvent(t, JSON.parse((e as MessageEvent).data)));
  return () => es.close();
}
