import { yaml } from "@codemirror/lang-yaml";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import CodeMirror from "@uiw/react-codemirror";
import { AlertCircle, CheckCircle2, FilePlus2, FlaskConical, Monitor, Play, Save, Search, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type TestInfo } from "../api";
import { markRunFailedToStart, markRunStarting, useLiveRun } from "../run-store";
import { navigate } from "../App";
import { TestRunCard } from "../components/run-view";
import { Badge, Button, cx, Empty, ErrorNote, Input, Kbd, Modal, Switch, useDark } from "../components/ui";

const NEW_TEST = (id: string) => `fileType: memento/test/v1
id: ${id}
description: Describe what this test proves
url: /
steps:
  - click: the Sign in button
  - fill:
      text: "{{ env.QA_EMAIL }}"
      into: the Email field
  - assert: The dashboard is shown
`;

export function TestsPage() {
  const [tests, setTests] = useState<TestInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [headed, setHeaded] = useState(() => localStorage.getItem("headed") === "1");
  const [noCache, setNoCache] = useState(false);
  const live = useLiveRun();

  const load = useCallback(async () => {
    const t = await api.tests();
    setTests(t);
    setSelected((s) => s ?? t[0]?.file ?? null);
  }, []);
  useEffect(() => void load(), [load]);
  useEffect(() => localStorage.setItem("headed", headed ? "1" : "0"), [headed]);
  useEffect(() => {
    if (!live.active && live.summary) void load();
  }, [live.active, live.summary, load]);

  const start = async (paths?: string[]) => {
    markRunStarting(paths ?? (tests ?? []).map((t) => t.file));
    try {
      await api.startRun({ paths, headed, disableCache: noCache });
      if (!paths) navigate({ page: "runs", arg: "live" });
    } catch (e) {
      markRunFailedToStart((e as Error).message);
    }
  };

  const shown = useMemo(() => (tests ?? []).filter((t) => `${t.id} ${t.file} ${t.description ?? ""}`.toLowerCase().includes(q.toLowerCase())), [tests, q]);
  const lastStatus = (file: string) => live.tests.find((t) => t.file === file)?.status;

  return (
    <div className="flex h-full">
      <section className="flex w-80 shrink-0 flex-col border-r border-line bg-panel">
        <div className="space-y-3 border-b border-line p-4">
          <div className="flex items-center justify-between">
            <h1 className="text-base font-semibold">Tests</h1>
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" icon={<FilePlus2 className="size-3.5" />} onClick={() => setCreating(true)}>
                New
              </Button>
              {live.active ? (
                <Button size="sm" variant="danger" icon={<Square className="size-3" />} onClick={() => api.stopRun()}>
                  Stop
                </Button>
              ) : (
                <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} disabled={!tests?.length} onClick={() => start()}>
                  Run all
                </Button>
              )}
            </div>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" />
            <Input placeholder="Filter tests" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
          </div>
        </div>
        <ul className="flex-1 overflow-auto p-2">
          {shown.map((t) => {
            const st = lastStatus(t.file);
            return (
              <li key={t.file}>
                <button
                  onClick={() => setSelected(t.file)}
                  className={cx("flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left", selected === t.file ? "bg-accent-soft" : "hover:bg-subtle")}
                >
                  <span className={cx("mt-1.5 size-2 shrink-0 rounded-full", t.error ? "bg-bad" : st === "passed" ? "bg-ok" : st === "failed" ? "bg-bad" : st === "running" ? "animate-pulse bg-accent" : "bg-line")} />
                  <span className="min-w-0 flex-1">
                    <span className={cx("block truncate text-sm font-medium", selected === t.file && "text-accent")}>{t.id}</span>
                    <span className="block truncate text-xs text-muted">{t.error ? "Invalid YAML" : (t.description ?? t.file)}</span>
                  </span>
                  <span className="text-[11px] text-muted tabular-nums">{t.steps}</span>
                </button>
              </li>
            );
          })}
          {tests && !tests.length && (
            <Empty icon={<FlaskConical />} title="No tests yet" action={<Button onClick={() => navigate({ page: "write" })}>Write tests with AI</Button>}>
              Create one by hand, or let AI draft tests from your code.
            </Empty>
          )}
        </ul>
        <div className="space-y-2.5 border-t border-line p-4">
          <Switch checked={headed} onChange={setHeaded} label={<span className="flex items-center gap-1.5 text-muted"><Monitor className="size-3.5" /> Show browser window</span>} />
          <Switch checked={noCache} onChange={setNoCache} label={<span className="text-muted">Ignore step cache</span>} />
        </div>
      </section>

      <section className="min-w-0 flex-1">
        {selected ? (
          <Editor key={selected} file={selected} onSaved={load} onDeleted={() => { setSelected(null); void load(); }} onRun={() => start([selected])} running={live.active} />
        ) : (
          <Empty icon={<FlaskConical />} title="Select a test">Pick a test on the left to edit and run it.</Empty>
        )}
      </section>

      <NewTestModal open={creating} onClose={() => setCreating(false)} onCreated={(f) => { setCreating(false); void load().then(() => setSelected(f)); }} />
    </div>
  );
}

function Editor({ file, onSaved, onDeleted, onRun, running }: { file: string; onSaved: () => void; onDeleted: () => void; onRun: () => void; running: boolean }) {
  const [content, setContent] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const live = useLiveRun();
  const dark = useDark();
  const timer = useRef<number>(undefined);

  useEffect(() => {
    api.readFile(file).then((c) => {
      setContent(c);
      setSaved(c);
    });
  }, [file]);

  const onChange = (v: string) => {
    setContent(v);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => api.validate(file, v).then(setError), 300);
  };
  const dirty = content !== null && content !== saved;
  const save = async () => {
    if (content === null) return;
    setSaveError(null);
    try {
      await api.writeFile(file, content);
      setSaved(content);
      onSaved();
    } catch (e) {
      setSaveError((e as Error).message);
    }
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (!running) void save().then(onRun);
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const liveTest = live.tests.find((t) => t.file === file);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-line bg-panel px-5 py-2.5">
        <span className="font-mono text-[13px]">{file}</span>
        {dirty && <Badge tone="warn">unsaved</Badge>}
        <span className="flex-1" />
        {error ? (
          <span className="flex max-w-md items-center gap-1.5 truncate text-xs text-bad" title={error}>
            <AlertCircle className="size-3.5 shrink-0" /> {error}
          </span>
        ) : (
          content !== null && (
            <span className="flex items-center gap-1.5 text-xs text-ok">
              <CheckCircle2 className="size-3.5" /> Valid
            </span>
          )
        )}
        <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={async () => {
          if (confirm(`Delete ${file}?`)) {
            await api.deleteFile(file);
            onDeleted();
          }
        }} />
        <Button size="sm" icon={<Save className="size-3.5" />} disabled={!dirty} onClick={save}>
          Save <Kbd>⌘S</Kbd>
        </Button>
        <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} disabled={running || !!error} onClick={() => save().then(onRun)}>
          Run <Kbd>⌘↵</Kbd>
        </Button>
      </div>
      {saveError && <div className="px-5 pt-3"><ErrorNote>{saveError}</ErrorNote></div>}
      <div className="min-h-0 flex-1 overflow-hidden">
        {content !== null && (
          <CodeMirror value={content} onChange={onChange} extensions={[yaml()]} theme={dark ? githubDark : githubLight} height="100%" basicSetup={{ foldGutter: true, highlightActiveLine: true }} className="h-full" />
        )}
      </div>
      {liveTest && (
        <div className="max-h-[45%] overflow-auto border-t border-line bg-bg p-4">
          <TestRunCard test={liveTest} />
        </div>
      )}
    </div>
  );
}

function NewTestModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (file: string) => void }) {
  const [id, setId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    const slug = id.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) return;
    const file = `memento/${slug}.test.yaml`;
    try {
      await api.writeFile(file, NEW_TEST(slug));
      setId("");
      onCreated(file);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="New test">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <Input autoFocus placeholder="e.g. guest checkout" value={id} onChange={(e) => setId(e.target.value)} />
        <p className="text-xs text-muted">Saved as <code className="font-mono">memento/{id.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "…"}.test.yaml</code></p>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary">Create</Button>
        </div>
      </form>
    </Modal>
  );
}
