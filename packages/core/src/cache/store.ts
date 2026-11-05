import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ElementFingerprint } from "../browser/inpage.js";

/**
 * Step cache.
 *
 * After the AI resolves "the Sign in button" once, we store several
 * independent ways to find that element again plus the signals the locator
 * said it relied on. On later runs the element is found WITHOUT an LLM call
 * as long as those signals still hold; otherwise the AI re-resolves it
 * (auto-heal) and the entry is updated.
 *
 * AI actions cache their whole trajectory (the concrete steps the agent took),
 * so a reliable `act` costs zero model calls after the first green run.
 *
 * Storage is a JSON file per test under `.memento/cache/` — local, inspectable,
 * and optionally committable. Backends (S3, a team server) can implement
 * `CacheBackend`.
 */

export interface LocatorSignals {
  text: boolean;
  role: boolean;
  attributes: string[];
  visual: boolean;
  position: boolean;
}

export interface LocatorCacheEntry {
  kind: "locator";
  description: string;
  fingerprint: ElementFingerprint;
  signals: LocatorSignals;
  savedAt: number;
}

export interface ActCacheEntry {
  kind: "act";
  goal: string;
  /** Serialized concrete steps (YAML-shaped objects) the agent executed. */
  trajectory: Array<Record<string, unknown>>;
  postcondition?: string;
  savedAt: number;
}

export type CacheEntry = LocatorCacheEntry | ActCacheEntry;

export interface CacheBackend {
  load(testId: string): Record<string, CacheEntry>;
  save(testId: string, entries: Record<string, CacheEntry>): void;
}

export class FileCacheBackend implements CacheBackend {
  constructor(private readonly dir: string) {}
  private file(testId: string) {
    return join(this.dir, `${testId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
  }
  load(testId: string): Record<string, CacheEntry> {
    const f = this.file(testId);
    if (!existsSync(f)) return {};
    try {
      return JSON.parse(readFileSync(f, "utf8")).entries ?? {};
    } catch {
      return {};
    }
  }
  save(testId: string, entries: Record<string, CacheEntry>): void {
    mkdirSync(this.dir, { recursive: true });
    const f = this.file(testId);
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, testId, entries }, null, 2));
    renameSync(tmp, f);
  }
}

/** Per-test view of the cache; collects writes and commits them at the end. */
export class TestCache {
  private entries: Record<string, CacheEntry>;
  private dirty = false;
  readonly stats = { hits: 0, misses: 0, healed: 0 };

  constructor(
    private readonly backend: CacheBackend | null,
    private readonly testId: string,
    private readonly ttlMs: number,
  ) {
    const loaded = backend?.load(testId) ?? {};
    const now = Date.now();
    this.entries = Object.fromEntries(Object.entries(loaded).filter(([, e]) => now - e.savedAt < ttlMs));
  }

  get enabled() {
    return this.backend !== null;
  }

  get<K extends CacheEntry["kind"]>(key: string, kind: K): Extract<CacheEntry, { kind: K }> | undefined {
    const e = this.entries[key];
    return e && e.kind === kind ? (e as Extract<CacheEntry, { kind: K }>) : undefined;
  }

  set(key: string, entry: CacheEntry): void {
    if (!this.backend) return;
    this.entries[key] = entry;
    this.dirty = true;
  }

  delete(key: string): void {
    if (key in this.entries) {
      delete this.entries[key];
      this.dirty = true;
    }
  }

  commit(): void {
    if (this.backend && this.dirty) this.backend.save(this.testId, this.entries);
    this.dirty = false;
  }
}

export function cacheKey(...parts: string[]): string {
  return createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

/**
 * Decide whether a cached element still matches what the step meant.
 * Only the signals the locator actually relied on are enforced, so cosmetic
 * changes (class names, unrelated attributes, layout shifts) don't cause misses,
 * while a reordered list row with different text does.
 */
export function cachedElementStillValid(entry: LocatorCacheEntry, live: ElementFingerprint, votes: number): boolean {
  const old = entry.fingerprint;
  const s = entry.signals;
  if (old.tag !== live.tag) return false;
  if (s.role && old.role !== live.role) return false;
  if (s.text && norm(old.name || old.text) !== norm(live.name || live.text)) return false;
  for (const a of s.attributes) if ((old.attributes[a] ?? "") !== (live.attributes[a] ?? "")) return false;
  if (s.position) {
    const dx = Math.abs(old.bbox.x - live.bbox.x);
    const dy = Math.abs(old.bbox.y - live.bbox.y);
    if (dx > 80 || dy > 80) return false;
  }
  // With no strong signal recorded, require at least two selectors to agree
  // or the visible text to be unchanged.
  if (!s.text && !s.role && s.attributes.length === 0 && !s.position) {
    return votes >= 2 || norm(old.text) === norm(live.text);
  }
  return true;
}

function norm(s: string) {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}
