import { Bot, Check, ExternalLink, KeyRound, Plus, Server, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type AiSettings, type Provider, type Settings } from "../api";
import { navigate } from "../App";
import { Github, Badge, Button, Card, cx, ErrorNote, Field, Input, PageHeader, Select, Spinner, Switch } from "../components/ui";

const AGENTS: Array<{ id: string; label: string; hint: string }> = [
  { id: "default", label: "Default", hint: "Used by every agent without its own model" },
  { id: "locator", label: "Element finder", hint: "Many small calls — a fast, cheap model works well" },
  { id: "assertion", label: "Assertions", hint: "Judges AI checks against the page" },
  { id: "act", label: "AI actions", hint: "Multi-step goals — use your strongest model" },
  { id: "review", label: "Reviewer", hint: "Independently confirms AI actions" },
  { id: "extract", label: "Extraction", hint: "Reads values from the page" },
  { id: "recovery", label: "Recovery", hint: "Clears cookie banners and pop-ups" },
  { id: "author", label: "Test writer", hint: "Reads your code and drafts tests" },
];

const PRESETS: Array<{ name: string; label: string; provider: Provider; keyVar?: string; models: string[] }> = [
  { name: "anthropic", label: "Anthropic", provider: { type: "anthropic" }, keyVar: "ANTHROPIC_API_KEY", models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"] },
  { name: "openai", label: "OpenAI", provider: { type: "openai" }, keyVar: "OPENAI_API_KEY", models: ["gpt-5", "gpt-5-mini"] },
  { name: "google", label: "Google Gemini", provider: { type: "google" }, keyVar: "GOOGLE_GENERATIVE_AI_API_KEY", models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  { name: "openrouter", label: "OpenRouter", provider: { type: "openai-compatible", baseURL: "https://openrouter.ai/api/v1" }, keyVar: "OPENROUTER_API_KEY", models: ["anthropic/claude-sonnet-5-5", "openai/gpt-5"] },
  { name: "ollama", label: "Ollama (local)", provider: { type: "openai-compatible", baseURL: "http://localhost:11434/v1", vision: false }, models: ["qwen2.5:14b", "llama3.1:8b"] },
  { name: "lmstudio", label: "LM Studio (local)", provider: { type: "openai-compatible", baseURL: "http://localhost:1234/v1", vision: false }, models: [] },
];

export function SettingsPage({ tab = "ai", onGithubChange }: { tab?: string; onGithubChange: () => void }) {
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="flex gap-1 border-b border-line px-8">
        {[
          ["ai", "AI models"],
          ["github", "GitHub"],
          ["project", "Project"],
        ].map(([id, label]) => (
          <button key={id} onClick={() => navigate({ page: "settings", arg: id })} className={cx("-mb-px border-b-2 px-3 py-2.5 text-sm", tab === id ? "border-accent font-medium" : "border-transparent text-muted hover:text-fg")}>
            {label}
          </button>
        ))}
      </div>
      <div className="mx-auto max-w-3xl px-8 py-6">
        {tab === "ai" && <AiSettingsForm />}
        {tab === "github" && (
          <Card className="p-5">
            <GithubConnect onChange={onGithubChange} />
          </Card>
        )}
        {tab === "project" && <ProjectSettings />}
      </div>
    </div>
  );
}

function keyVarOf(p: Provider) {
  return typeof p.apiKey === "string" ? (p.apiKey.match(/^\$\{([A-Z0-9_]+)(?::-[^}]*)?\}$/)?.[1] ?? "") : "";
}

function AiSettingsForm() {
  const [s, setS] = useState<Settings | null>(null);
  const [ai, setAi] = useState<AiSettings>({});
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api.settings().then((x) => {
      setS(x);
      setAi({ ...x.ai, providers: { ...(x.ai.providers ?? {}) }, models: { ...(x.ai.models ?? {}) } });
    }, (e) => setError(e.message));
  useEffect(() => void load(), []);
  if (!s) return error ? <ErrorNote>{error}</ErrorNote> : <div className="flex justify-center py-10"><Spinner /></div>;

  const providers = ai.providers ?? {};
  const setProvider = (name: string, p: Provider | null, rename?: string) => {
    const next = { ...providers };
    delete next[name];
    if (p) next[rename ?? name] = p;
    setAi({ ...ai, providers: next });
  };
  const addPreset = (preset: (typeof PRESETS)[number]) => {
    let name = preset.name;
    for (let i = 2; providers[name]; i++) name = `${preset.name}${i}`;
    setProvider(name, { ...preset.provider, ...(preset.keyVar ? { apiKey: `\${${preset.keyVar}}` } : {}) });
    if (!ai.models?.default && preset.models[0]) setAi((a) => ({ ...a, providers: { ...(a.providers ?? {}), [name]: { ...preset.provider, ...(preset.keyVar ? { apiKey: `\${${preset.keyVar}}` } : {}) } }, models: { ...(a.models ?? {}), default: `${name}:${preset.models[0]}` } }));
  };
  const suggestions = Object.entries(providers).flatMap(([name, p]) => {
    const preset = PRESETS.find((x) => x.name === name.replace(/\d+$/, "")) ?? PRESETS.find((x) => x.provider.type === p.type && x.provider.baseURL === p.baseURL);
    return (preset?.models ?? []).map((m) => `${name}:${m}`);
  });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      for (const [v, value] of Object.entries(keys)) if (value) await api.setSecret(v, value);
      await api.saveSettings({ ai });
      setKeys({});
      await load();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-3 flex items-end justify-between">
          <div>
            <h2 className="font-semibold">Providers</h2>
            <p className="text-sm text-muted">Bring your own models. Keys are stored in <code className="font-mono text-xs">~/.memento/credentials.json</code> on this computer, never in the project.</p>
          </div>
        </div>
        <div className="space-y-3">
          {Object.entries(providers).map(([name, p]) => {
            const kv = keyVarOf(p);
            const stored = kv && s.secrets.includes(kv);
            return (
              <Card key={name} className="p-4">
                <div className="mb-3 flex items-center gap-2">
                  <Server className="size-4 text-muted" />
                  <span className="font-medium">{name}</span>
                  <Badge>{p.type}</Badge>
                  <span className="flex-1" />
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setProvider(name, null)} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Name">
                    <Input value={name} onChange={(e) => setProvider(name, p, e.target.value.replace(/[^a-z0-9_-]/gi, ""))} />
                  </Field>
                  <Field label="Type">
                    <Select value={p.type} onChange={(e) => setProvider(name, { ...p, type: e.target.value as Provider["type"] })}>
                      <option value="anthropic">Anthropic</option>
                      <option value="openai">OpenAI</option>
                      <option value="google">Google</option>
                      <option value="openai-compatible">OpenAI-compatible</option>
                    </Select>
                  </Field>
                  <Field label="Base URL" hint={p.type === "openai-compatible" ? "Required for OpenAI-compatible servers" : "Optional"}>
                    <Input value={p.baseURL ?? ""} placeholder="https://…" onChange={(e) => setProvider(name, { ...p, baseURL: e.target.value || undefined })} />
                  </Field>
                  <Field label="API key variable" hint="The config references it as ${VAR}">
                    <Input value={kv} placeholder="e.g. ANTHROPIC_API_KEY" onChange={(e) => {
                      const v = e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "");
                      setProvider(name, { ...p, apiKey: v ? `\${${v}}` : undefined });
                    }} />
                  </Field>
                  {kv && (
                    <div className="col-span-2">
                      <Field label="API key" hint={stored ? <span className="flex items-center gap-1 text-ok"><Check className="size-3" /> Stored on this computer — paste a new key to replace it</span> : "Paste your key; it's saved locally when you click Save"}>
                        <div className="relative">
                          <KeyRound className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted" />
                          <Input type="password" className="pl-9" value={keys[kv] ?? ""} placeholder={stored ? "••••••••••••" : "sk-…"} onChange={(e) => setKeys({ ...keys, [kv]: e.target.value })} />
                        </div>
                      </Field>
                    </div>
                  )}
                  <div className="col-span-2">
                    <Switch checked={p.vision !== false} onChange={(v) => setProvider(name, { ...p, vision: v ? undefined : false })} label="Models accept screenshots (vision)" />
                  </div>
                </div>
              </Card>
            );
          })}
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <Button key={p.name} size="sm" icon={<Plus className="size-3.5" />} onClick={() => addPreset(p)}>
                {p.label}
              </Button>
            ))}
          </div>
        </div>
      </section>

      <section>
        <h2 className="font-semibold">Models</h2>
        <p className="mb-3 text-sm text-muted">Use <code className="font-mono text-xs">provider:model</code>. Separate with commas to fall back in order if a provider fails.</p>
        <Card className="divide-y divide-line">
          <datalist id="model-suggestions">{suggestions.map((m) => <option key={m} value={m} />)}</datalist>
          {AGENTS.map((a) => {
            const v = ai.models?.[a.id];
            return (
              <div key={a.id} className="grid grid-cols-[200px_1fr] items-center gap-4 px-4 py-3">
                <div>
                  <div className="flex items-center gap-1.5 text-sm font-medium"><Bot className="size-3.5 text-muted" />{a.label}</div>
                  <div className="text-xs text-muted">{a.hint}</div>
                </div>
                <Input
                  list="model-suggestions"
                  value={Array.isArray(v) ? v.join(", ") : (v ?? "")}
                  placeholder={a.id === "default" ? "anthropic:claude-sonnet-5-5" : `Default (${s.resolvedModels.default ?? "none"})`}
                  onChange={(e) => {
                    const list = e.target.value.split(",").map((x) => x.trim());
                    const models = { ...(ai.models ?? {}) };
                    if (!e.target.value.trim()) delete models[a.id];
                    else models[a.id] = list.length > 1 ? list : e.target.value.trim();
                    setAi({ ...ai, models });
                  }}
                />
              </div>
            );
          })}
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold">Behaviour</h2>
        <Card className="space-y-3 p-4">
          <Switch checked={ai.vision !== false} onChange={(v) => setAi({ ...ai, vision: v })} label="Send screenshots to models (better accuracy, more tokens)" />
          <Switch checked={!!ai.failureRecovery} onChange={(v) => setAi({ ...ai, failureRecovery: v })} label="Recover from transient obstructions (cookie banners, pop-ups) before failing a step" />
        </Card>
      </section>

      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="sticky bottom-0 -mx-8 flex justify-end gap-2 border-t border-line bg-bg/90 px-8 py-4 backdrop-blur">
        <Button variant="primary" loading={saving} icon={saved ? <Check className="size-4" /> : undefined} onClick={save}>
          {saved ? "Saved" : "Save settings"}
        </Button>
      </div>
    </div>
  );
}

export function GithubConnect({ onChange }: { onChange: () => void }) {
  const [st, setSt] = useState<{ connected: boolean; login?: string; avatar?: string; source?: string; error?: string } | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.github().then(setSt, (e) => setError(e.message));
  useEffect(() => void load(), []);
  const connect = async (t: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await api.setGithubToken(t);
      setToken("");
      await load();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!st) return <div className="flex justify-center py-6"><Spinner /></div>;
  if (st.connected) {
    return (
      <div className="flex items-center gap-3">
        {st.avatar ? <img src={st.avatar} alt="" className="size-10 rounded-full" /> : <Github className="size-8" />}
        <div className="flex-1">
          <div className="font-medium">Connected as {st.login}</div>
          <div className="text-xs text-muted">{st.source === "gh" ? "Using your GitHub CLI login (gh auth)" : st.source === "env" ? "Using GITHUB_TOKEN from the environment" : "Using a token saved on this computer"}</div>
        </div>
        {st.source === "saved" && <Button onClick={() => connect(null)} loading={busy}>Disconnect</Button>}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <Github className="mt-0.5 size-6 shrink-0" />
        <div>
          <div className="font-medium">Connect GitHub</div>
          <p className="text-sm text-muted">Memento uses your repositories to read code when writing tests, and opens pull requests with new tests and a PR workflow.</p>
        </div>
      </div>
      <div className="rounded-lg border border-line bg-subtle/50 p-3 text-sm">
        <span className="font-medium">Easiest:</span> if you use the GitHub CLI, run <code className="rounded bg-panel px-1.5 py-0.5 font-mono text-xs">gh auth login</code> in a terminal, then reload this page.
      </div>
      <Field
        label="Or paste a personal access token"
        hint={
          <>
            Create a{" "}
            <a className="inline-flex items-center gap-0.5 text-accent hover:underline" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
              fine-grained token <ExternalLink className="size-3" />
            </a>{" "}
            with Contents, Pull requests and Workflows set to read & write on the repositories you want to test.
          </>
        }
      >
        <div className="flex gap-2">
          <Input type="password" value={token} placeholder="github_pat_…" onChange={(e) => setToken(e.target.value)} />
          <Button variant="primary" loading={busy} disabled={!token.trim()} onClick={() => connect(token.trim())}>Connect</Button>
        </div>
      </Field>
      {(error || st.error) && <ErrorNote>{error ?? st.error}</ErrorNote>}
    </div>
  );
}

function ProjectSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.settings().then((x) => {
      setS(x);
      setBaseUrl(x.baseUrl ?? "");
    }, (e) => setError(e.message));
  }, []);
  if (!s) return error ? <ErrorNote>{error}</ErrorNote> : <Spinner />;
  return (
    <Card className="space-y-4 p-5">
      <Field label="Base URL" hint="Where your app runs. Tests with a relative url (e.g. /login) start here. You can reference env vars: ${MEMENTO_BASE_URL:-http://localhost:3000}">
        <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:3000" />
      </Field>
      {s.environments.length > 0 && <p className="text-sm text-muted">Environments: {s.environments.join(", ")} (edit in memento.config.yaml)</p>}
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex justify-end">
        <Button variant="primary" icon={saved ? <Check className="size-4" /> : undefined} onClick={async () => {
          try {
            await api.saveSettings({ baseUrl: baseUrl || null });
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
          } catch (e) {
            setError((e as Error).message);
          }
        }}>
          {saved ? "Saved" : "Save"}
        </Button>
      </div>
    </Card>
  );
}
