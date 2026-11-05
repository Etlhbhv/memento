import { safeStorage, app } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * API keys live in the OS keychain-backed store (Electron safeStorage: macOS
 * Keychain, Windows DPAPI, libsecret on Linux) — never in the project repo.
 * They are injected as environment variables when a run starts, so config
 * files can keep referencing `${ANTHROPIC_API_KEY}`.
 */
const file = () => join(app.getPath("userData"), "secrets.bin");

export function loadSecrets(): Record<string, string> {
  if (!existsSync(file()) || !safeStorage.isEncryptionAvailable()) return {};
  try {
    return JSON.parse(safeStorage.decryptString(readFileSync(file())));
  } catch {
    return {};
  }
}

export function saveSecret(name: string, value: string | null): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("OS secure storage is not available on this system");
  const all = loadSecrets();
  if (value) all[name] = value;
  else delete all[name];
  writeFileSync(file(), safeStorage.encryptString(JSON.stringify(all)));
}

/** Names only — the renderer never receives secret values. */
export function secretNames(): string[] {
  return Object.keys(loadSecrets());
}
