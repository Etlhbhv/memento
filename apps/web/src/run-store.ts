import { useSyncExternalStore } from "react";
import { subscribe, type RunSummary, type StepResult, type TestResult } from "./api";

/** Live state of the current run, fed by server-sent events. */
export interface LiveStep {
  path: string;
  label: string;
  status: StepResult["status"] | "running";
  result?: StepResult;
}
export interface LiveTest {
  testId: string;
  file: string;
  status: TestResult["status"] | "queued" | "running";
  steps: LiveStep[];
  result?: TestResult;
}
export interface LiveRun {
  active: boolean;
  runId?: string;
  tests: LiveTest[];
  summary?: RunSummary;
  error?: string;
  startedAt?: number;
}

let state: LiveRun = { active: false, tests: [] };
const listeners = new Set<() => void>();
const set = (fn: (s: LiveRun) => LiveRun) => {
  state = fn(state);
  for (const l of listeners) l();
};
const authorListeners = new Set<(type: string, payload: any) => void>();

const updateTest = (testId: string, fn: (t: LiveTest) => LiveTest) =>
  set((s) => ({ ...s, tests: s.tests.map((t) => (t.testId === testId ? fn(t) : t)) }));

subscribe((type, p) => {
  switch (type) {
    case "run:start":
      set(() => ({ active: true, runId: p.runId, startedAt: Date.now(), tests: p.tests.map((t: { id: string; file: string }) => ({ testId: t.id, file: t.file, status: "queued", steps: [] })) }));
      break;
    case "test:start":
      updateTest(p.testId, (t) => ({ ...t, status: "running", steps: [] }));
      break;
    case "step:start":
      if (p.path.includes(".ai[")) break;
      updateTest(p.testId, (t) => ({ ...t, steps: [...t.steps, { path: p.path, label: p.label, status: "running" }] }));
      break;
    case "step:end": {
      const r: StepResult = p.result;
      if (r.path.includes(".ai[")) break;
      updateTest(p.testId, (t) => ({
        ...t,
        steps: t.steps.some((s) => s.path === r.path)
          ? t.steps.map((s) => (s.path === r.path ? { ...s, label: r.label, status: r.status, result: r } : s))
          : [...t.steps, { path: r.path, label: r.label, status: r.status, result: r }],
      }));
      break;
    }
    case "test:end":
      updateTest(p.testId, (t) => ({ ...t, status: p.status, result: p }));
      break;
    case "run:end":
      set((s) => ({ ...s, active: false, summary: p }));
      break;
    case "run:error":
      set((s) => ({ ...s, active: false, error: p.message }));
      break;
    default:
      for (const l of authorListeners) l(type, p);
  }
});

export function useLiveRun(): LiveRun {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export function markRunStarting(files: string[]) {
  set(() => ({ active: true, startedAt: Date.now(), tests: files.map((f) => ({ testId: f, file: f, status: "queued", steps: [] })) }));
}
export function markRunFailedToStart(message: string) {
  set((s) => ({ ...s, active: false, error: message }));
}

export function onAuthorEvent(fn: (type: string, payload: any) => void) {
  authorListeners.add(fn);
  return () => {
    authorListeners.delete(fn);
  };
}
