import { ArrowLeft, Clock, Folder, FolderOpen, Lock, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type AppState, type Repo } from "../api";
import { GithubConnect } from "./settings";
import { Github, Badge, Button, Card, cx, ErrorNote, Input, Spinner } from "../components/ui";
import { timeAgo } from "../components/run-view";

type Tab = "recent" | "folder" | "github";

export function ProjectPicker({ state, onOpened, onGithubChange }: { state: AppState; onOpened: () => void; onGithubChange: () => void }) {
  const [tab, setTab] = useState<Tab>(state.recentProjects.length ? "recent" : "folder");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const open = async (dir: string) => {
    setBusy(dir);
    setError(null);
    try {
      await api.openProject(dir);
      onOpened();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="overflow-hidden shadow-xl">
      <div className="flex border-b border-line px-2">
        {(
          [
            ["recent", "Recent", <Clock key="c" className="size-4" />],
            ["folder", "Folder on this computer", <Folder key="f" className="size-4" />],
            ["github", "GitHub repository", <Github key="g" className="size-4" />],
          ] as const
        ).map(([id, label, icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cx("-mb-px flex items-center gap-2 border-b-2 px-3 py-3 text-sm", tab === id ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg")}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>
      <div className="p-4">
        {error && <div className="mb-3"><ErrorNote>{error}</ErrorNote></div>}
        {tab === "recent" &&
          (state.recentProjects.length ? (
            <ul className="space-y-1">
              {state.recentProjects.map((d) => (
                <li key={d}>
                  <button onClick={() => open(d)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-subtle">
                    <FolderOpen className="size-4 text-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{d.split(/[\\/]/).pop()}</span>
                      <span className="block truncate text-xs text-muted">{d}</span>
                    </span>
                    {busy === d && <Spinner />}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-center text-sm text-muted">No recent projects yet.</p>
          ))}
        {tab === "folder" && <FolderBrowser start={state.home} onPick={open} busy={!!busy} />}
        {tab === "github" && (state.github.connected ? <RepoList onCloned={onOpened} /> : <GithubConnect onChange={onGithubChange} />)}
      </div>
    </Card>
  );
}

function FolderBrowser({ start, onPick, busy }: { start: string; onPick: (d: string) => void; busy: boolean }) {
  const [dir, setDir] = useState(start);
  const [data, setData] = useState<{ dir: string; parent: string | null; entries: string[]; isProject: boolean } | null>(null);
  const [path, setPath] = useState(start);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.fs(dir).then(
      (d) => {
        setData(d);
        setPath(d.dir);
        setError(null);
      },
      (e) => setError(e.message),
    );
  }, [dir]);
  return (
    <div className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setDir(path);
        }}
      >
        <Input value={path} onChange={(e) => setPath(e.target.value)} className="font-mono text-xs" />
        <Button type="submit">Go</Button>
      </form>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="h-72 overflow-auto rounded-lg border border-line">
        {data?.parent && (
          <button onClick={() => setDir(data.parent!)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted hover:bg-subtle">
            <ArrowLeft className="size-4" /> ..
          </button>
        )}
        {data?.entries.map((e) => (
          <button key={e} onClick={() => setDir(`${data.dir}/${e}`)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-subtle">
            <Folder className="size-4 text-muted" /> {e}
          </button>
        ))}
        {data && !data.entries.length && <p className="px-3 py-6 text-center text-sm text-muted">No sub-folders</p>}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">{data?.isProject ? "This folder already has memento.config.yaml." : "A memento.config.yaml will be created here."}</span>
        <Button variant="primary" loading={busy} onClick={() => data && onPick(data.dir)}>
          Open this folder
        </Button>
      </div>
    </div>
  );
}

function RepoList({ onCloned }: { onCloned: () => void }) {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.repos().then(setRepos, (e) => setError(e.message));
  }, []);
  const shown = useMemo(() => (repos ?? []).filter((r) => r.fullName.toLowerCase().includes(q.toLowerCase())).slice(0, 100), [repos, q]);
  const clone = async (r: Repo) => {
    setBusy(r.fullName);
    setError(null);
    try {
      await api.clone(r.fullName);
      onCloned();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" />
        <Input placeholder="Search repositories" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" autoFocus />
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="h-80 overflow-auto rounded-lg border border-line">
        {!repos && !error && <div className="flex justify-center py-10"><Spinner /></div>}
        {shown.map((r) => (
          <button key={r.fullName} disabled={!!busy} onClick={() => clone(r)} className="flex w-full items-center gap-3 border-b border-line px-3 py-2.5 text-left last:border-0 hover:bg-subtle">
            <Github className="size-4 shrink-0 text-muted" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm font-medium">
                {r.fullName}
                {r.private && (
                  <Badge>
                    <Lock className="size-3" /> private
                  </Badge>
                )}
              </span>
              <span className="block truncate text-xs text-muted">{r.description ?? `Updated ${timeAgo(Date.parse(r.pushedAt))}`}</span>
            </span>
            {busy === r.fullName ? <span className="flex items-center gap-2 text-xs text-muted"><Spinner /> Cloning…</span> : <span className="text-xs text-accent">Open</span>}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">The repository is cloned to <code className="font-mono">~/.memento/repos</code>. Tests you save there can be proposed back as a pull request.</p>
    </div>
  );
}
