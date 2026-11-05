import { Check, ChevronRight, CircleDashed, Clock, Cpu, Database, ExternalLink, Image as ImageIcon, Loader2, Sparkles, TriangleAlert, Wrench, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, artifactUrl, type StepResult, type TestResult } from "../api";
import type { LiveStep, LiveTest } from "../run-store";
import { Badge, Button, cx } from "./ui";

export function StatusIcon({ status, className }: { status: string; className?: string }) {
  const base = cx("size-4 shrink-0", className);
  switch (status) {
    case "passed":
      return (
        <span className={cx("flex items-center justify-center rounded-full bg-ok text-white", base)}>
          <Check className="size-3" strokeWidth={3} />
        </span>
      );
    case "failed":
      return (
        <span className={cx("flex items-center justify-center rounded-full bg-bad text-white", base)}>
          <X className="size-3" strokeWidth={3} />
        </span>
      );
    case "softFailed":
      return <TriangleAlert className={cx(base, "text-warn")} />;
    case "running":
      return <Loader2 className={cx(base, "animate-spin text-accent")} />;
    case "queued":
      return <Clock className={cx(base, "text-muted")} />;
    default:
      return <CircleDashed className={cx(base, "text-muted")} />;
  }
}

export function ResolutionBadge({ r }: { r?: StepResult }) {
  if (!r) return null;
  return (
    <>
      {r.resolution === "cache" && (
        <Badge>
          <Database className="size-3" /> cache
        </Badge>
      )}
      {r.resolution === "ai" && (
        <Badge tone="accent">
          <Sparkles className="size-3" /> AI
        </Badge>
      )}
      {r.resolution === "healed" && (
        <Badge tone="warn">
          <Wrench className="size-3" /> healed
        </Badge>
      )}
      {r.recovered && <Badge tone="warn">recovered</Badge>}
    </>
  );
}

function StepRow({ step, depth = 0 }: { step: LiveStep | StepResult; depth?: number }) {
  const r: StepResult | undefined = "result" in step ? step.result : "ai" in step ? (step as StepResult) : undefined;
  const [open, setOpen] = useState(false);
  const failed = step.status === "failed" || step.status === "softFailed";
  const expandable = !!(r && (r.reasoning || r.error || r.screenshot || r.children?.length || r.ai.length));
  return (
    <li>
      <button
        type="button"
        onClick={() => expandable && setOpen(!open)}
        className={cx("group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px]", expandable && "hover:bg-subtle", failed && "bg-bad-soft/60")}
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        <StatusIcon status={step.status} />
        <span className={cx("min-w-0 flex-1 truncate", step.status === "skipped" && "text-muted line-through")}>{step.label}</span>
        <ResolutionBadge r={r} />
        {r && r.ai.length > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-muted">
            <Cpu className="size-3" />
            {r.ai.length}
          </span>
        )}
        {r && <span className="w-14 text-right font-mono text-[11px] text-muted tabular-nums">{fmtMs(r.durationMs)}</span>}
        {expandable && <ChevronRight className={cx("size-3.5 text-muted transition-transform", open && "rotate-90")} />}
      </button>
      {failed && r?.error && !open && <pre className="mx-2 mt-1 mb-2 overflow-x-auto rounded-md bg-bad-soft px-3 py-2 text-xs whitespace-pre-wrap text-bad" style={{ marginLeft: 32 + depth * 16 }}>{r.error}</pre>}
      {open && r && (
        <div className="mx-2 mt-1 mb-3 space-y-2 rounded-lg border border-line bg-subtle/60 p-3 text-xs" style={{ marginLeft: 32 + depth * 16 }}>
          {r.error && <pre className="overflow-x-auto whitespace-pre-wrap text-bad">{r.error}</pre>}
          {r.reasoning && (
            <p>
              <span className="font-medium text-fg">AI reasoning: </span>
              <span className="text-muted">{r.reasoning}</span>
            </p>
          )}
          {r.ai.length > 0 && (
            <p className="text-muted">
              {r.ai.map((c, i) => (
                <span key={i} className="mr-3">
                  {c.agent} · {c.model} · {fmtMs(c.durationMs)} · {c.inputTokens + c.outputTokens} tok
                </span>
              ))}
            </p>
          )}
          {r.screenshot && (
            <a href={artifactUrl(r.screenshot)} target="_blank" rel="noreferrer">
              <img src={artifactUrl(r.screenshot)} alt="Screenshot at failure" className="max-h-72 rounded-md border border-line" />
            </a>
          )}
          {r.children && r.children.length > 0 && (
            <ul className="-mx-1">
              {r.children.map((c) => (
                <StepRow key={c.path} step={c} depth={0} />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

export function TestRunCard({ test, defaultOpen = true }: { test: LiveTest | TestResult; defaultOpen?: boolean }) {
  const live = "steps" in test && !("before" in test) ? (test as LiveTest) : undefined;
  const result: TestResult | undefined = live ? live.result : (test as TestResult);
  const status = live ? live.status : (test as TestResult).status;
  const [open, setOpen] = useState(defaultOpen || status === "failed");
  // Expand automatically when a test starts running or fails during a live run.
  useEffect(() => {
    if (status === "failed" || status === "running") setOpen(true);
  }, [status]);
  const steps: Array<LiveStep | StepResult> = live && !result ? live.steps : result ? [...result.before, ...result.steps, ...result.after] : [];
  return (
    <div className={cx("overflow-hidden rounded-xl border bg-panel", status === "failed" ? "border-bad/30" : "border-line")}>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-subtle/50">
        <StatusIcon status={status} className="size-[18px]" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{test.file}</span>
          {result?.description && <span className="block truncate text-xs text-muted">{result.description}</span>}
        </span>
        {result && (
          <span className="flex items-center gap-3 text-xs text-muted">
            <span className="flex items-center gap-1">
              <Cpu className="size-3.5" /> {result.ai.calls} AI
            </span>
            <span className="flex items-center gap-1">
              <Database className="size-3.5" /> {result.cache.hits}/{result.cache.hits + result.cache.misses}
            </span>
            <span className="font-mono tabular-nums">{fmtMs(result.durationMs)}</span>
          </span>
        )}
        <ChevronRight className={cx("size-4 text-muted transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="border-t border-line px-2 py-2">
          {steps.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted">{status === "queued" ? "Waiting…" : "Starting browser…"}</p>
          ) : (
            <ul>
              {steps.map((s) => (
                <StepRow key={s.path} step={s} />
              ))}
            </ul>
          )}
          {result && status === "failed" && result.error && !steps.some((s) => s.status === "failed") && (
            <pre className="m-2 rounded-md bg-bad-soft px-3 py-2 text-xs whitespace-pre-wrap text-bad">{result.error}</pre>
          )}
          {result && (result.trace || result.video) && (
            <div className="flex gap-2 px-2 pt-2 pb-1">
              {result.trace && (
                <Button size="sm" icon={<ExternalLink className="size-3.5" />} onClick={() => api.openTrace(result.trace!)}>
                  Open trace
                </Button>
              )}
              {result.video && (
                <a href={artifactUrl(result.video)} target="_blank" rel="noreferrer">
                  <Button size="sm" icon={<ImageIcon className="size-3.5" />}>
                    Video
                  </Button>
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function fmtMs(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function timeAgo(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}
