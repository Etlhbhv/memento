import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Per-user state in ~/.memento (override with MEMENTO_HOME):
 *   credentials.json  API keys + GitHub token, file mode 0600 (like gh / aws CLIs)
 *   state.json        recent projects
 *   repos/            GitHub repositories cloned for test authoring
 */
export function mementoHome(): string {
  const dir = process.env.MEMENTO_HOME ?? join(homedir(), ".memento");
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface Credentials {
  secrets: Record<string, string>;
  githubToken?: string;
}

const credFile = () => join(mementoHome(), "credentials.json");

export function readCredentials(): Credentials {
  try {
    const c = JSON.parse(readFileSync(credFile(), "utf8"));
    return { secrets: c.secrets ?? {}, githubToken: c.githubToken };
  } catch {
    return { secrets: {} };
  }
}

export function writeCredentials(c: Credentials): void {
  const f = credFile();
  writeFileSync(f, JSON.stringify(c, null, 2), { mode: 0o600 });
  try {
    chmodSync(f, 0o600);
  } catch {}
}

export function setSecret(name: string, value: string | null): void {
  const c = readCredentials();
  if (value) c.secrets[name] = value;
  else delete c.secrets[name];
  writeCredentials(c);
}

/** Make stored keys visible to `${VAR}` expansion in memento.config.yaml. Real env vars win. */
export function applySecretsToEnv(): void {
  for (const [k, v] of Object.entries(readCredentials().secrets)) if (!process.env[k]) process.env[k] = v;
}

interface State {
  recentProjects: string[];
}

const stateFile = () => join(mementoHome(), "state.json");

export function readState(): State {
  try {
    return { recentProjects: [], ...JSON.parse(readFileSync(stateFile(), "utf8")) };
  } catch {
    return { recentProjects: [] };
  }
}

export function rememberProject(dir: string): void {
  const s = readState();
  s.recentProjects = [dir, ...s.recentProjects.filter((d) => d !== dir && existsSync(d))].slice(0, 12);
  writeFileSync(stateFile(), JSON.stringify(s, null, 2));
}
