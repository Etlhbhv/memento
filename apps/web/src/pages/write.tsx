import { yaml } from "@codemirror/lang-yaml";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import CodeMirror from "@uiw/react-codemirror";
import { AlertCircle, CheckCircle2, ChevronRight, ExternalLink, GitPullRequest, Save, Sparkles, Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type AppState, type AuthorResult, type DraftTest } from "../api";
import { navigate } from "../App";
import { onAuthorEvent } from "../run-store";
import { Github, Badge, Button, Card, cx, ErrorNote, Field, Input, PageHeader, Select, Switch, Textarea, useDark } from "../components/ui";

interface Draft extends DraftTest {
  include: boolean;
  open: boolean;
}

export function WritePage({ state }: { state: AppState }) {
  const [request, setRequest] = useState("");
  const [count, setCount] = useState(5);
  const [job, setJob] = useState<string | null>(null);
  const [result, setResult] = useState<AuthorResult | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState("memento");
  const [withWorkflow, setWithWorkflow] = useState(true);
  const [busy, setBusy] = useState<"save" | "pr" | null>(null);
  const [done, setDone] = useState<{ kind: "saved" | "pr"; url?: string; count: number } | null>(null);
  const [model, setModel] = useState<string>("");

  useEffect(() => {
    api.settings().then((s) => setModel(s.resolvedModels.author ?? ""), () => {});
  }, []);

  useEffect(
    () =>
      onAuthorEvent((type, p) => {
        if (p.id !== job) return;
        if (type === "author:done") {
          setResult(p.result);
          setDrafts(p.result.tests.map((t: DraftTest) => ({ ...t, include: t.valid, open: false })));
        } else setError(p.error);
        setJob(null);
      }),
    [job],
  );

  const draft = async () => {
    setError(null);
    setResult(null);
    setDone(null);
    try {
      const { id } = await api.author({ request: request || undefined, maxTests: count });
      setJob(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const files = async () => {
    const out = drafts.filter((d) => d.include && d.valid).map((d) => ({ path: `${folder.replace(/\/+$/, "")}/${d.fileName}`, content: d.yaml }));
    if (withWorkflow) {
      const wf = await api.workflow();
      out.push(wf);
    }
    // Never replace existing tests silently.
    const existing = new Set((await api.tests()).map((t) => t.file));
    const clashes = out.filter((f) => existing.has(f.path)).map((f) => f.path);
    if (clashes.length && !confirm(`These files already exist and will be replaced:\n\n${clashes.join("\n")}\n\nContinue?`)) {
      throw new Error("Cancelled — rename the drafts to keep the existing files.");
    }
    return out;
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    try {
      const f = await files();
      for (const x of f) await api.writeFile(x.path, x.content);
      setDone({ kind: "saved", count: f.length });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const pr = async () => {
    setBusy("pr");
    setError(null);
    try {
      const f = await files();
      const r = await api.openPr({ files: f, title: `Add ${drafts.filter((d) => d.include).length} Memento end-to-end tests` });
      setDone({ kind: "pr", url: r.url, count: f.length });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const update = (i: number, patch: Partial<Draft>) => setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const selected = drafts.filter((d) => d.include && d.valid).length;
  const dark = useDark();

  return (
    <div>
      <PageHeader
        title="Write tests with AI"
        description={
          <>
            Memento reads this project's code — routes, pages, forms and labels — and drafts tests for its most important journeys.
            {model && <> Using <code className="font-mono text-xs">{model}</code>.</>}
          </>
        }
      />
      <div className="mx-auto max-w-4xl space-y-5 px-8 py-6">
        <Card className="space-y-4 p-5">
          {state.projectRepo ? (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Github className="size-4" /> {state.projectRepo}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted">
              This folder isn't a GitHub repository — you can still draft and save tests.{" "}
              <button className="text-accent hover:underline" onClick={() => navigate({ page: "settings", arg: "github" })}>Connect GitHub</button>
            </div>
          )}
          <Field label="What should the tests cover?" hint="Optional. Leave empty to let the AI pick the most important journeys.">
            <Textarea rows={3} value={request} onChange={(e) => setRequest(e.target.value)} placeholder="e.g. Sign-up and log-in, creating a project, and the pricing page" />
          </Field>
          <div className="flex items-end gap-3">
            <div className="w-40">
              <Field label="Number of tests">
                <Select value={count} onChange={(e) => setCount(Number(e.target.value))}>
                  {[1, 3, 5, 8, 10].map((n) => <option key={n} value={n}>{n}</option>)}
                </Select>
              </Field>
            </div>
            <span className="flex-1" />
            <Button variant="primary" icon={<Sparkles className="size-4" />} loading={!!job} onClick={draft}>
              {job ? "Reading your code…" : result ? "Draft again" : "Draft tests"}
            </Button>
          </div>
        </Card>

        {error && <ErrorNote>{error}</ErrorNote>}

        {job && (
          <Card className="space-y-3 p-5">
            {[0, 1, 2].map((i) => <div key={i} className="h-12 animate-pulse rounded-lg bg-subtle" style={{ animationDelay: `${i * 120}ms` }} />)}
            <p className="text-center text-xs text-muted">This usually takes 20–60 seconds.</p>
          </Card>
        )}

        {result && (
          <>
            <Card className="p-5">
              <h3 className="mb-1 text-sm font-semibold">What the AI found</h3>
              <p className="text-sm whitespace-pre-wrap text-muted">{result.analysis}</p>
              <p className="mt-3 text-xs text-muted">
                {result.model} · {(result.usage.inputTokens + result.usage.outputTokens).toLocaleString()} tokens
              </p>
            </Card>

            <div className="space-y-2">
              {drafts.map((d, i) => (
                <Card key={i} className={cx("overflow-hidden", !d.valid && "border-bad/30")}>
                  <div className="flex items-start gap-3 p-4">
                    <input type="checkbox" className="mt-1 size-4 accent-[var(--accent)]" checked={d.include} disabled={!d.valid} onChange={(e) => update(i, { include: e.target.checked })} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Input value={d.fileName} onChange={(e) => update(i, { fileName: e.target.value })} className="h-7 max-w-xs font-mono text-xs" />
                        {d.valid ? (
                          <Badge tone="ok"><CheckCircle2 className="size-3" /> valid</Badge>
                        ) : (
                          <Badge tone="bad"><AlertCircle className="size-3" /> invalid</Badge>
                        )}
                      </div>
                      <p className="mt-2 text-sm text-muted">{d.rationale}</p>
                      {d.variables.length > 0 && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                          Needs: {d.variables.map((v) => <Badge key={v} tone="accent">{v}</Badge>)}
                        </div>
                      )}
                      {d.error && <p className="mt-2 text-xs text-bad">{d.error}</p>}
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => update(i, { open: !d.open })}>
                      YAML <ChevronRight className={cx("size-3.5 transition-transform", d.open && "rotate-90")} />
                    </Button>
                  </div>
                  {d.open && (
                    <div className="border-t border-line">
                      <CodeMirror
                        value={d.yaml}
                        extensions={[yaml()]}
                        theme={dark ? githubDark : githubLight}
                        onChange={(v) => api.validate(`memento/${d.fileName}`, v).then((err) => update(i, { yaml: v, valid: !err, error: err ?? undefined }))}
                        maxHeight="420px"
                      />
                    </div>
                  )}
                </Card>
              ))}
            </div>

            <Card className="space-y-4 p-5">
              <div className="grid grid-cols-2 gap-4">
                <Field label="Folder in the project">
                  <Input value={folder} onChange={(e) => setFolder(e.target.value)} className="font-mono text-xs" />
                </Field>
                <div className="flex items-end pb-2">
                  <Switch
                    checked={withWorkflow}
                    onChange={setWithWorkflow}
                    label={<span className="flex items-center gap-1.5"><Workflow className="size-4 text-muted" /> Add a workflow that runs tests on every pull request</span>}
                  />
                </div>
              </div>
              {done && (
                <div className="flex items-center gap-2 rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">
                  <CheckCircle2 className="size-4" />
                  {done.kind === "saved" ? `Saved ${done.count} files to the project.` : <>Pull request opened. <a href={done.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium underline">View on GitHub <ExternalLink className="size-3" /></a></>}
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                <span className="mr-auto text-xs text-muted">{selected} test{selected === 1 ? "" : "s"} selected</span>
                <Button icon={<Save className="size-4" />} loading={busy === "save"} disabled={!selected} onClick={save}>
                  Save to project
                </Button>
                <Button
                  variant="primary"
                  icon={<GitPullRequest className="size-4" />}
                  loading={busy === "pr"}
                  disabled={!selected || !state.projectRepo || !state.github.connected}
                  title={!state.projectRepo ? "Open a GitHub repository to create pull requests" : !state.github.connected ? "Connect GitHub first" : undefined}
                  onClick={pr}
                >
                  Open pull request
                </Button>
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
