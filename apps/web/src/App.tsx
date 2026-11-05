import { ChevronsUpDown, FlaskConical, History, Moon, Play, Settings, Sparkles, Sun } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, token, type AppState } from "./api";
import { ProjectPicker } from "./pages/projects";
import { RunsPage } from "./pages/runs";
import { SettingsPage } from "./pages/settings";
import { TestsPage } from "./pages/tests";
import { WritePage } from "./pages/write";
import { useLiveRun } from "./run-store";
import { Github, cx, Empty, Spinner } from "./components/ui";

export type Route = { page: "tests" | "runs" | "write" | "settings"; arg?: string };

function parseRoute(): Route {
  const [page, arg] = location.hash.replace(/^#\/?/, "").split("/");
  return { page: (["tests", "runs", "write", "settings"].includes(page) ? page : "tests") as Route["page"], arg };
}
export const navigate = (r: Route) => (location.hash = `/${r.page}${r.arg ? `/${r.arg}` : ""}`);

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(parseRoute);
  const [picker, setPicker] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem("theme") === "dark" || (!localStorage.getItem("theme") && matchMedia("(prefers-color-scheme: dark)").matches));
  const live = useLiveRun();

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    const h = () => setRoute(parseRoute());
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  const refresh = useCallback(() => api.state().then(setState, (e) => setError(e.message)), []);
  useEffect(() => void refresh(), [refresh]);

  if (!token) {
    return (
      <Centered>
        <Empty icon={<FlaskConical />} title="Open Memento from the terminal">
          Run <code className="rounded bg-subtle px-1.5 py-0.5 font-mono">memento ui</code> — it opens this page with a secure session link.
        </Empty>
      </Centered>
    );
  }
  if (error) return <Centered><Empty icon={<FlaskConical />} title="Can't reach the Memento server">{error}</Empty></Centered>;
  if (!state) return <Centered><Spinner className="size-6" /></Centered>;

  const onOpened = async () => {
    setPicker(false);
    await refresh();
    navigate({ page: "tests" });
  };

  if (!state.project) {
    return (
      <div className="min-h-full bg-bg">
        <div className="mx-auto max-w-2xl px-6 pt-20">
          <Logo className="mb-8" />
          <h1 className="text-3xl font-semibold tracking-tight">Open a project</h1>
          <p className="mt-2 text-muted">Pick a folder on this computer, or connect GitHub and choose a repository. Memento keeps tests as YAML files in the project.</p>
          <div className="mt-8">
            <ProjectPicker state={state} onOpened={onOpened} onGithubChange={refresh} />
          </div>
        </div>
      </div>
    );
  }

  const name = state.project.split(/[\\/]/).pop();
  const running = live.active;

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel">
        <div className="px-4 pt-4 pb-3">
          <Logo />
        </div>
        <button onClick={() => setPicker(true)} className="mx-3 mb-3 flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-left hover:bg-subtle">
          <span className="flex size-6 items-center justify-center rounded-md bg-accent-soft text-xs font-semibold text-accent uppercase">{name?.[0]}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{name}</span>
            <span className="block truncate text-[11px] text-muted">{state.projectRepo ?? state.project}</span>
          </span>
          <ChevronsUpDown className="size-4 text-muted" />
        </button>
        <nav className="space-y-0.5 px-3">
          <NavItem icon={<FlaskConical />} label="Tests" active={route.page === "tests"} onClick={() => navigate({ page: "tests" })} />
          <NavItem icon={<History />} label="Runs" active={route.page === "runs"} onClick={() => navigate({ page: "runs" })} extra={running && <span className="size-2 animate-pulse rounded-full bg-accent" />} />
          <NavItem icon={<Sparkles />} label="Write with AI" active={route.page === "write"} onClick={() => navigate({ page: "write" })} />
          <NavItem icon={<Settings />} label="Settings" active={route.page === "settings"} onClick={() => navigate({ page: "settings" })} />
        </nav>
        <div className="mt-auto space-y-2 border-t border-line p-3">
          {running && (
            <button onClick={() => navigate({ page: "runs", arg: "live" })} className="flex w-full items-center gap-2 rounded-lg bg-accent-soft px-3 py-2 text-xs font-medium text-accent">
              <Play className="size-3.5" /> Run in progress · {live.tests.filter((t) => t.result).length}/{live.tests.length}
            </button>
          )}
          <div className="flex items-center justify-between">
            <button onClick={() => navigate({ page: "settings", arg: "github" })} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted hover:bg-subtle hover:text-fg">
              <Github className="size-3.5" />
              {state.github.connected ? "GitHub connected" : "Connect GitHub"}
            </button>
            <button onClick={() => setDark(!dark)} className="rounded-md p-1.5 text-muted hover:bg-subtle hover:text-fg" title="Toggle theme">
              {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-auto bg-bg">
        {route.page === "tests" && <TestsPage key={state.project} />}
        {route.page === "runs" && <RunsPage key={state.project} runId={route.arg} />}
        {route.page === "write" && <WritePage key={state.project} state={state} />}
        {route.page === "settings" && <SettingsPage key={state.project} tab={route.arg} onGithubChange={refresh} />}
      </main>

      {picker && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[8vh] backdrop-blur-[2px]" onMouseDown={() => setPicker(false)}>
          <div onMouseDown={(e) => e.stopPropagation()} className="w-full max-w-2xl">
            <ProjectPicker state={state} onOpened={onOpened} onGithubChange={refresh} />
          </div>
        </div>
      )}
    </div>
  );
}

function NavItem({ icon, label, active, onClick, extra }: { icon: ReactNode; label: string; active: boolean; onClick: () => void; extra?: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors [&>svg]:size-4",
        active ? "bg-subtle font-medium text-fg" : "text-muted hover:bg-subtle/60 hover:text-fg",
      )}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {extra}
    </button>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cx("flex items-center gap-2", className)}>
      <svg viewBox="0 0 32 32" className="size-7">
        <rect width="32" height="32" rx="8" className="fill-accent" />
        <path d="M9 22V10l7 7 7-7v12" stroke="white" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight">Memento</span>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center">{children}</div>;
}
