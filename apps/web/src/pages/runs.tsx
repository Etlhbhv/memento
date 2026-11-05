import { ArrowLeft, History, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type RunListItem, type RunSummary } from "../api";
import { navigate } from "../App";
import { useLiveRun } from "../run-store";
import { fmtMs, StatusIcon, TestRunCard, timeAgo } from "../components/run-view";
import { Badge, Button, Card, Empty, ErrorNote, PageHeader, Spinner } from "../components/ui";

export function RunsPage({ runId }: { runId?: string }) {
  if (runId === "live") return <LiveRunView />;
  if (runId) return <RunDetail id={runId} />;
  return <RunList />;
}

function RunList() {
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const live = useLiveRun();
  useEffect(() => {
    api.runs().then(setRuns, () => setRuns([]));
  }, [live.active]);
  return (
    <div>
      <PageHeader title="Runs" description="Every run is saved in the project's memento-results folder." />
      <div className="mx-auto max-w-4xl space-y-4 px-8 py-6">
        {live.active && (
          <button onClick={() => navigate({ page: "runs", arg: "live" })} className="flex w-full items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft px-4 py-3 text-left">
            <StatusIcon status="running" />
            <span className="flex-1 text-sm font-medium text-accent">Run in progress</span>
            <span className="text-xs text-accent">{live.tests.filter((t) => t.result).length} of {live.tests.length} done</span>
          </button>
        )}
        {!runs && <div className="flex justify-center py-10"><Spinner /></div>}
        {runs && !runs.length && !live.active && <Empty icon={<History />} title="No runs yet">Run a test from the Tests page.</Empty>}
        {runs && runs.length > 0 && (
          <Card>
            <ul className="divide-y divide-line">
              {runs.map((r) => (
                <li key={r.runId}>
                  <button onClick={() => navigate({ page: "runs", arg: r.runId })} className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-subtle/60">
                    <StatusIcon status={r.failed ? "failed" : "passed"} className="size-[18px]" />
                    <span className="flex-1">
                      <span className="block text-sm font-medium">
                        {r.failed ? `${r.failed} failed` : "All passed"}
                        <span className="font-normal text-muted"> · {r.tests} test{r.tests === 1 ? "" : "s"}</span>
                      </span>
                      <span className="block text-xs text-muted">{timeAgo(r.startedAt)}</span>
                    </span>
                    <span className="flex gap-1.5">
                      {r.passed > 0 && <Badge tone="ok">{r.passed} passed</Badge>}
                      {r.failed > 0 && <Badge tone="bad">{r.failed} failed</Badge>}
                    </span>
                    <span className="w-16 text-right font-mono text-xs text-muted">{fmtMs(r.durationMs)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

function LiveRunView() {
  const live = useLiveRun();
  const done = live.tests.filter((t) => t.result);
  return (
    <div>
      <PageHeader
        title={live.active ? "Running…" : live.summary ? (live.summary.failed ? `${live.summary.failed} failed, ${live.summary.passed} passed` : `All ${live.summary.passed} passed`) : "Live run"}
        description={live.active ? `${done.length} of ${live.tests.length} tests finished` : live.summary ? `Finished in ${fmtMs(live.summary.durationMs)}` : undefined}
        actions={
          <>
            <Button icon={<ArrowLeft className="size-4" />} onClick={() => navigate({ page: "runs" })}>All runs</Button>
            {live.active && <Button variant="danger" icon={<Square className="size-3.5" />} onClick={() => api.stopRun()}>Stop</Button>}
          </>
        }
      />
      <div className="mx-auto max-w-4xl space-y-3 px-8 py-6">
        {live.error && <ErrorNote>{live.error}</ErrorNote>}
        {live.tests.length > 0 && (
          <div className="h-1.5 overflow-hidden rounded-full bg-subtle">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(done.length / live.tests.length) * 100}%` }} />
          </div>
        )}
        {live.tests.map((t) => <TestRunCard key={t.testId} test={t} defaultOpen={t.status === "running" || t.status === "failed"} />)}
        {!live.tests.length && !live.error && <Empty icon={<History />} title="Nothing running">Start a run from the Tests page.</Empty>}
      </div>
    </div>
  );
}

function RunDetail({ id }: { id: string }) {
  const [run, setRun] = useState<RunSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.run(id).then(setRun, (e) => setError(e.message));
  }, [id]);
  return (
    <div>
      <PageHeader
        title={run ? (run.failed ? `${run.failed} failed, ${run.passed} passed` : `All ${run.passed} passed`) : "Run"}
        description={run ? `${new Date(run.startedAt).toLocaleString()} · ${fmtMs(run.durationMs)}` : undefined}
        actions={<Button icon={<ArrowLeft className="size-4" />} onClick={() => navigate({ page: "runs" })}>All runs</Button>}
      />
      <div className="mx-auto max-w-4xl space-y-3 px-8 py-6">
        {error && <ErrorNote>{error}</ErrorNote>}
        {!run && !error && <div className="flex justify-center py-10"><Spinner /></div>}
        {run?.results.map((r) => <TestRunCard key={`${r.testId}-${r.attempt}`} test={r} defaultOpen={r.status === "failed"} />)}
      </div>
    </div>
  );
}
