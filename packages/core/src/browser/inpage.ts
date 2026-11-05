/**
 * Code that runs INSIDE the browser page via `page.evaluate`.
 *
 * Every function here must be self-contained: Playwright serializes the
 * function source, so it cannot reference anything from the module scope.
 * `installMemento` installs a helper object on `window.__memento` once per
 * document; the other functions call into it.
 */

export interface SnapshotOptions {
  maxChars: number;
  importantAttributes: string[];
  bannedAttributes: string[];
  /** Include text-only nodes (needed for assertions; locators mostly need interactive ones). */
  includeText: boolean;
}

export interface SnapshotResult {
  text: string;
  url: string;
  title: string;
  elementCount: number;
  truncated: boolean;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
}

export interface ElementFingerprint {
  tag: string;
  role: string;
  name: string;
  text: string;
  attributes: Record<string, string>;
  bbox: { x: number; y: number; width: number; height: number };
  /** Several independent unique-ish CSS selectors for the element. */
  selectors: string[];
  /** Primary selector used to drive Playwright. */
  selector: string;
}

/* eslint-disable */
export function installMemento(): void {
  const w = window as any;
  if (w.__memento && w.__memento.version === 1) return;

  const IMPLICIT_ROLES: Record<string, string> = {
    a: "link", button: "button", select: "combobox", textarea: "textbox", img: "img",
    h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
    nav: "navigation", main: "main", header: "banner", footer: "contentinfo", form: "form",
    table: "table", tr: "row", td: "cell", th: "columnheader", ul: "list", ol: "list", li: "listitem",
    dialog: "dialog", option: "option", summary: "button", label: "label", section: "region",
    aside: "complementary", progress: "progressbar", details: "group",
  };
  const INPUT_ROLES: Record<string, string> = {
    button: "button", submit: "button", reset: "button", image: "button", checkbox: "checkbox",
    radio: "radio", range: "slider", search: "searchbox", email: "textbox", tel: "textbox",
    text: "textbox", url: "textbox", password: "textbox", number: "spinbutton",
  };
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "slider", "spinbutton",
    "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "listbox",
  ]);
  const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "meta", "link", "head", "svg", "path"]);

  function role(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "input") return INPUT_ROLES[(el as HTMLInputElement).type || "text"] || "textbox";
    if (tag === "a" && !el.hasAttribute("href")) return "generic";
    return IMPLICIT_ROLES[tag] || "generic";
  }

  function clean(s: string | null | undefined, max = 120): string {
    if (!s) return "";
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  }

  function accessibleName(el: Element): string {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const t = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
      if (t.trim()) return clean(t);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const id = el.getAttribute("id");
      if (id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl?.textContent?.trim()) return clean(lbl.textContent);
      }
      const parentLabel = el.closest("label");
      if (parentLabel?.textContent?.trim()) return clean(parentLabel.textContent);
      const t = (el as HTMLInputElement).type;
      if (t === "submit" || t === "button") return clean((el as HTMLInputElement).value);
      return clean(el.getAttribute("placeholder") || el.getAttribute("title") || "");
    }
    if (tag === "img") return clean(el.getAttribute("alt") || el.getAttribute("title") || "");
    const title = el.getAttribute("title");
    const text = clean((el as HTMLElement).innerText ?? el.textContent ?? "", 120);
    return text || clean(title || "");
  }

  function isVisible(el: Element): boolean {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (Number(style.opacity) === 0 && !isInteractive(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      // display: contents and zero-size wrappers can still have visible children.
      return style.display === "contents";
    }
    return true;
  }

  function isInteractive(el: Element): boolean {
    const r = role(el);
    if (INTERACTIVE_ROLES.has(r)) return true;
    const tag = el.tagName.toLowerCase();
    if (["input", "select", "textarea", "button", "summary"].includes(tag)) return true;
    if (el.hasAttribute("onclick") || el.hasAttribute("contenteditable") || (el.getAttribute("tabindex") ?? "-1") !== "-1") return true;
    try {
      if (getComputedStyle(el).cursor === "pointer") {
        // Only count the outermost pointer element, not every child of a clickable card.
        const p = el.parentElement;
        if (!p || getComputedStyle(p).cursor !== "pointer") return true;
      }
    } catch {}
    return false;
  }

  function cssPath(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      const tag = cur.tagName.toLowerCase();
      const parent: Element | null = cur.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(cur) + 1})` : tag);
      cur = parent;
    }
    return parts.join(" > ");
  }

  function isUnique(sel: string, el: Element): boolean {
    try {
      const m = document.querySelectorAll(sel);
      return m.length === 1 && m[0] === el;
    } catch { return false; }
  }

  /** Looks like a generated / hashed value that will change between builds. */
  function unstable(v: string): boolean {
    return /\d{4,}|[a-f0-9]{8,}|^[a-z]{1,3}-[A-Za-z0-9_-]{5,}$|^:r[0-9a-z]+:$|__/.test(v);
  }

  function selectorsFor(el: Element): string[] {
    const out: string[] = [];
    const tag = el.tagName.toLowerCase();
    for (const a of ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"]) {
      const v = el.getAttribute(a);
      if (v) { const s = `[${a}="${CSS.escape(v)}"]`; if (isUnique(s, el)) out.push(s); }
    }
    const id = el.getAttribute("id");
    if (id && !unstable(id)) { const s = `#${CSS.escape(id)}`; if (isUnique(s, el)) out.push(s); }
    for (const a of ["aria-label", "name", "placeholder", "title", "alt", "href", "type"]) {
      const v = el.getAttribute(a);
      if (v && v.length < 100 && !unstable(v)) {
        const s = `${tag}[${a}="${CSS.escape(v)}"]`;
        if (isUnique(s, el)) out.push(s);
      }
    }
    const classes = Array.from(el.classList).filter((c) => !unstable(c)).slice(0, 3);
    if (classes.length) {
      const s = tag + classes.map((c) => "." + CSS.escape(c)).join("");
      if (isUnique(s, el)) out.push(s);
    }
    out.push(cssPath(el));
    return Array.from(new Set(out));
  }

  const IMPORTANT_DEFAULT = [
    "id", "name", "type", "placeholder", "aria-label", "aria-expanded", "aria-checked", "aria-selected",
    "aria-disabled", "aria-current", "aria-pressed", "data-testid", "data-test-id", "data-test", "data-cy",
    "href", "title", "alt", "value", "for", "disabled", "checked", "readonly", "required", "contenteditable",
  ];

  const state = {
    version: 1,
    els: [] as Element[],
    ids: new WeakMap<Element, number>(),
    idFor(el: Element): number {
      let id = this.ids.get(el);
      if (id === undefined) {
        id = this.els.length;
        this.els.push(el);
        this.ids.set(el, id);
      }
      return id;
    },
    role, accessibleName, isVisible, isInteractive, selectorsFor, clean, IMPORTANT_DEFAULT,
  };
  w.__memento = state;
}

export function takeSnapshot(opts: SnapshotOptions): SnapshotResult {
  const M = (window as any).__memento;
  const lines: string[] = [];
  let count = 0;
  let size = 0;
  let truncated = false;
  const important = new Set<string>([...M.IMPORTANT_DEFAULT, ...opts.importantAttributes]);
  for (const b of opts.bannedAttributes) important.delete(b);
  const vw = window.innerWidth, vh = window.innerHeight;

  function attrs(el: Element): string {
    const parts: string[] = [];
    for (const a of Array.from(el.attributes)) {
      if (!important.has(a.name)) continue;
      let v = a.value;
      if (a.name === "href" && v.length > 60) v = v.slice(0, 57) + "...";
      if (v.length > 80) v = v.slice(0, 77) + "...";
      parts.push(v === "" ? a.name : `${a.name}=${JSON.stringify(v)}`);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      const input = el as HTMLInputElement;
      if (input.type === "checkbox" || input.type === "radio") parts.push(input.checked ? "checked" : "unchecked");
      else if (input.value && input.type !== "password") parts.push(`value=${JSON.stringify(M.clean(input.value, 60))}`);
    }
    if (tag === "select") {
      const sel = el as HTMLSelectElement;
      const opt = sel.options[sel.selectedIndex];
      if (opt) parts.push(`selected=${JSON.stringify(M.clean(opt.text, 40))}`);
      const all = Array.from(sel.options).slice(0, 15).map((o) => M.clean(o.text, 30));
      parts.push(`options=${JSON.stringify(all)}`);
    }
    return parts.join(" ");
  }

  function visit(node: Node, depth: number): void {
    if (truncated) return;
    if (node.nodeType === Node.TEXT_NODE) return;
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "noscript", "template", "meta", "link", "head"].includes(tag)) return;
    if (el.getAttribute("aria-hidden") === "true" && !M.isInteractive(el)) return;
    if (!M.isVisible(el)) return;

    const role = M.role(el);
    const interactive = M.isInteractive(el);
    const children = Array.from((el as any).shadowRoot ? (el as any).shadowRoot.childNodes : el.childNodes) as Node[];
    if ((el as any).shadowRoot) children.push(...Array.from(el.childNodes));

    // Direct text owned by this element (not its children).
    let ownText = "";
    for (const c of Array.from(el.childNodes)) if (c.nodeType === Node.TEXT_NODE) ownText += c.textContent;
    ownText = M.clean(ownText, 160);

    const isHeading = role === "heading";
    const isLandmark = ["dialog", "navigation", "main", "form", "table", "row", "list", "listitem", "region", "banner", "contentinfo", "alert", "status", "tablist", "menu", "img"].includes(role);
    const a = attrs(el);
    const keep = interactive || isHeading || isLandmark || tag === "label" || (opts.includeText && ownText) || /data-test|aria-label/.test(a);

    let nextDepth = depth;
    if (keep) {
      const id = M.idFor(el);
      const r = el.getBoundingClientRect();
      const off = r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw;
      let name = interactive || isHeading || tag === "img" ? M.accessibleName(el) : "";
      // Avoid repeating text that will also appear on children.
      if (!interactive && !isHeading && tag !== "img") name = "";
      const label = role !== "generic" ? role : tag;
      let line = `${"  ".repeat(depth)}[${id}] ${label}`;
      if (name) line += ` ${JSON.stringify(name)}`;
      if (role === "heading") line += ` level=${tag.slice(1) || el.getAttribute("aria-level") || ""}`;
      if (a) line += ` ${a}`;
      if (ownText && ownText !== name) line += ` text=${JSON.stringify(ownText)}`;
      if (off) line += " (offscreen)";
      size += line.length + 1;
      if (size > opts.maxChars) { truncated = true; return; }
      lines.push(line);
      count++;
      nextDepth = depth + 1;
      // Interactive leaf controls: their text was captured as the name; children add noise.
      if (interactive && (tag === "button" || tag === "a" || tag === "select" || role === "option") && name) {
        // Still descend for nested interactive elements (rare), but skip plain text.
        for (const c of children) if (c.nodeType === Node.ELEMENT_NODE && M.isInteractive(c as Element)) visit(c, nextDepth);
        return;
      }
    } else if (ownText && opts.includeText) {
      // handled above
    }
    for (const c of children) visit(c, nextDepth);
    // Same-origin iframes.
    if (tag === "iframe") {
      try {
        const doc = (el as HTMLIFrameElement).contentDocument;
        if (doc?.body) visit(doc.body, nextDepth);
      } catch {}
    }
  }

  visit(document.body, 0);
  return {
    text: lines.join("\n"),
    url: location.href,
    title: document.title,
    elementCount: count,
    truncated,
    viewport: { width: vw, height: vh, scrollX: window.scrollX, scrollY: window.scrollY },
  };
}

/** Describe an element (by snapshot id) so it can be cached and acted on. */
export function fingerprintById(id: number): ElementFingerprint | null {
  const M = (window as any).__memento;
  const el: Element | undefined = M.els[id];
  if (!el || !el.isConnected) return null;
  return fingerprintElement(el, M);

  function fingerprintElement(el: Element, M: any): ElementFingerprint {
    // Redirect hidden backing elements (e.g. a visually hidden checkbox) to the
    // visible thing the user actually clicks.
    let target = el;
    const r0 = el.getBoundingClientRect();
    if (r0.width < 2 || r0.height < 2 || getComputedStyle(el).opacity === "0") {
      const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : el.closest("label");
      if (label) target = label;
    }
    const r = target.getBoundingClientRect();
    const attributes: Record<string, string> = {};
    for (const a of Array.from(target.attributes)) if (a.value.length < 200) attributes[a.name] = a.value;
    const selectors = M.selectorsFor(target);
    return {
      tag: target.tagName.toLowerCase(),
      role: M.role(target),
      name: M.accessibleName(target),
      text: M.clean((target as HTMLElement).innerText ?? target.textContent ?? "", 200),
      attributes,
      bbox: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      selectors,
      selector: selectors[0],
    };
  }
}

/**
 * Evaluate cached selectors against the live page and return the element that
 * the most selectors agree on, with its current fingerprint.
 */
export function resolveCachedSelectors(selectors: string[]): { votes: number; fingerprint: ElementFingerprint } | null {
  const M = (window as any).__memento;
  const tally = new Map<Element, number>();
  for (const s of selectors) {
    try {
      const m = document.querySelectorAll(s);
      if (m.length === 1) tally.set(m[0], (tally.get(m[0]) ?? 0) + 1);
    } catch {}
  }
  let best: Element | null = null;
  let votes = 0;
  for (const [el, n] of tally) if (n > votes) { best = el; votes = n; }
  if (!best || !M.isVisible(best)) return null;
  const r = best.getBoundingClientRect();
  const attributes: Record<string, string> = {};
  for (const a of Array.from(best.attributes)) if (a.value.length < 200) attributes[a.name] = a.value;
  const fresh = M.selectorsFor(best);
  return {
    votes,
    fingerprint: {
      tag: best.tagName.toLowerCase(),
      role: M.role(best),
      name: M.accessibleName(best),
      text: M.clean((best as HTMLElement).innerText ?? best.textContent ?? "", 200),
      attributes,
      bbox: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      selectors: fresh,
      selector: fresh[0],
    },
  };
}

/** Visible text of the whole page (for page-level checks and transcripts). */
export function pageText(): string {
  return (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, 50000);
}

/** Draw numbered boxes over elements so vision models can map ids to pixels ("set-of-marks"). */
export function drawMarks(ids: number[]): void {
  const M = (window as any).__memento;
  removeMarks();
  const layer = document.createElement("div");
  layer.id = "__memento_marks";
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  for (const id of ids) {
    const el: Element | undefined = M.els[id];
    if (!el || !el.isConnected) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.width === 0) continue;
    const box = document.createElement("div");
    box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:2px solid #e11d48;`;
    const tag = document.createElement("span");
    tag.textContent = String(id);
    tag.style.cssText = "position:absolute;left:0;top:-14px;background:#e11d48;color:#fff;font:bold 11px monospace;padding:0 3px;line-height:14px";
    box.appendChild(tag);
    layer.appendChild(box);
  }
  document.documentElement.appendChild(layer);

  function removeMarks() {
    document.getElementById("__memento_marks")?.remove();
  }
}

export function removeMarks(): void {
  document.getElementById("__memento_marks")?.remove();
}
