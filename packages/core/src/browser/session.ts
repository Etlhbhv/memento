import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from "playwright";
import type { MementoConfig } from "../config.js";
import {
  drawMarks,
  fingerprintById,
  installMemento,
  pageText,
  removeMarks,
  resolveCachedSelectors,
  takeSnapshot,
  type ElementFingerprint,
  type SnapshotResult,
} from "./inpage.js";

type BrowserCfg = MementoConfig["browser"];

/** Launches browsers. One launcher is shared by all tests in a run. */
export class BrowserPool {
  private browser?: Promise<Browser>;
  constructor(private readonly cfg: BrowserCfg) {}

  get(): Promise<Browser> {
    if (!this.browser) {
      const type = { chromium, firefox, webkit }[this.cfg.type];
      this.browser = type.launch({
        headless: this.cfg.headless,
        executablePath: this.cfg.executablePath || process.env.MEMENTO_BROWSER_PATH || undefined,
      });
    }
    return this.browser;
  }

  async close() {
    if (this.browser) await (await this.browser).close().catch(() => {});
    this.browser = undefined;
  }
}

/**
 * One test's browser state: a fresh context, its tabs, and the helpers
 * agents use to look at and act on the page.
 */
export class BrowserSession {
  private pending = 0;
  private lastNetworkActivity = Date.now();
  page!: Page;

  private constructor(
    readonly context: BrowserContext,
    readonly cfg: BrowserCfg,
  ) {}

  static async create(pool: BrowserPool, cfg: BrowserCfg, opts: { storageState?: string; recordVideoDir?: string } = {}) {
    const browser = await pool.get();
    const context = await browser.newContext({
      viewport: cfg.viewport,
      timezoneId: cfg.timezone,
      locale: cfg.locale,
      userAgent: cfg.userAgent,
      storageState: opts.storageState,
      recordVideo: opts.recordVideoDir ? { dir: opts.recordVideoDir, size: cfg.viewport } : undefined,
      acceptDownloads: true,
    });
    context.setDefaultTimeout(cfg.smartWaitingTimeoutMs);
    context.setDefaultNavigationTimeout(cfg.pageLoadTimeoutMs);
    const s = new BrowserSession(context, cfg);
    context.on("page", (p) => s.track(p));
    s.page = await context.newPage();
    return s;
  }

  private track(p: Page) {
    p.on("request", () => {
      this.pending++;
      this.lastNetworkActivity = Date.now();
    });
    const done = () => {
      this.pending = Math.max(0, this.pending - 1);
      this.lastNetworkActivity = Date.now();
    };
    p.on("requestfinished", done);
    p.on("requestfailed", done);
    p.on("close", () => {
      if (this.page === p) {
        const others = this.context.pages().filter((x) => x !== p);
        if (others.length) this.page = others[others.length - 1];
      }
    });
  }

  pages(): Page[] {
    return this.context.pages();
  }

  /**
   * Smart waiting: wait until the document has loaded, the network has been
   * quiet briefly, and the DOM has stopped changing — or the timeout elapses.
   * Never fails; it only bounds how long we wait.
   */
  async settle(timeoutMs = this.cfg.smartWaitingTimeoutMs): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await this.page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
    // Network quiet: no request in flight for 400ms (long-polling apps cap out at the deadline).
    while (Date.now() < deadline) {
      if (this.pending === 0 && Date.now() - this.lastNetworkActivity > 400) break;
      await sleep(100);
    }
    const remaining = Math.max(0, deadline - Date.now());
    await this.page
      .evaluate(
        ({ quietMs, maxMs }) =>
          new Promise<void>((resolve) => {
            let timer = setTimeout(done, quietMs);
            const hard = setTimeout(done, maxMs);
            const obs = new MutationObserver(() => {
              clearTimeout(timer);
              timer = setTimeout(done, quietMs);
            });
            obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
            function done() {
              obs.disconnect();
              clearTimeout(timer);
              clearTimeout(hard);
              resolve();
            }
          }),
        { quietMs: 250, maxMs: Math.min(remaining, 3000) },
      )
      .catch(() => {});
  }

  private async ensure(): Promise<void> {
    await this.page.evaluate(installMemento);
  }

  async snapshot(includeText = true): Promise<SnapshotResult> {
    await this.ensure();
    return this.page.evaluate(takeSnapshot, {
      maxChars: this.cfg.snapshotMaxChars,
      importantAttributes: this.cfg.importantAttributes,
      bannedAttributes: this.cfg.bannedAttributes,
      includeText,
    });
  }

  async pageText(): Promise<string> {
    return this.page.evaluate(pageText);
  }

  async screenshot(opts: { marks?: number[] } = {}): Promise<Buffer> {
    if (opts.marks?.length) await this.page.evaluate(drawMarks, opts.marks).catch(() => {});
    try {
      return await this.page.screenshot({ type: "jpeg", quality: 70, animations: "disabled", timeout: 10000 });
    } finally {
      if (opts.marks?.length) await this.page.evaluate(removeMarks).catch(() => {});
    }
  }

  async fingerprint(id: number): Promise<ElementFingerprint | null> {
    await this.ensure();
    return this.page.evaluate(fingerprintById, id);
  }

  async resolveCached(selectors: string[]) {
    await this.ensure();
    return this.page.evaluate(resolveCachedSelectors, selectors);
  }

  async close() {
    await this.context.close().catch(() => {});
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
