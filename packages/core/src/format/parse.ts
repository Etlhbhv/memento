import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { MementoFile, ModuleFile, ModuleParameter, Step, StepCommon, Target, TestFile, ValueExpr } from "./types.js";

export class FormatError extends Error {
  constructor(message: string, public readonly filePath?: string) {
    super(filePath ? `${filePath}: ${message}` : message);
    this.name = "FormatError";
  }
}

/** File types we accept. Momentic v2 files are accepted so suites can be imported as-is. */
const TEST_TYPES = new Set(["memento/test/v1", "momentic/test/v2"]);
const MODULE_TYPES = new Set(["memento/module/v1", "momentic/module/v2"]);

/** Commands that can be written as a bare one-word string, e.g. `- refresh`. */
const BARE_COMMANDS: Record<string, () => Step> = {
  refresh: () => ({ cmd: "refresh" }),
  goBack: () => ({ cmd: "goBack" }),
  goForward: () => ({ cmd: "goForward" }),
  closeTab: () => ({ cmd: "closeTab" }),
  blur: () => ({ cmd: "blur" }),
  authSave: () => ({ cmd: "authSave" }),
};

const COMMON_KEYS = ["comment", "skipped", "retries", "saveAs", "timeout", "soft", "cache"] as const;

export function parseFile(filePath: string, source?: string): MementoFile {
  const text = source ?? readFileSync(filePath, "utf8");
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new FormatError(`invalid YAML: ${(e as Error).message}`, filePath);
  }
  if (!isObj(doc)) throw new FormatError("file must be a YAML mapping", filePath);
  const fileType = String(doc.fileType ?? "");
  const id = doc.id == null ? undefined : String(doc.id);
  if (!id) throw new FormatError("missing `id`", filePath);

  const ctx = (section: string) => `${section}`;
  if (TEST_TYPES.has(fileType)) {
    const t: TestFile = {
      kind: "test",
      id,
      description: optStr(doc.description),
      url: optStr(doc.url),
      labels: Array.isArray(doc.labels) ? doc.labels.map(String) : undefined,
      disabled: doc.disabled === true,
      retries: typeof doc.retries === "number" ? doc.retries : undefined,
      before: parseSteps(doc.before, ctx("before"), filePath),
      steps: parseSteps(doc.steps, ctx("steps"), filePath),
      after: parseSteps(doc.after, ctx("after"), filePath),
      runAssertions: Array.isArray(doc.runAssertions) ? doc.runAssertions.map(String) : [],
      filePath,
    };
    return t;
  }
  if (MODULE_TYPES.has(fileType)) {
    const m: ModuleFile = {
      kind: "module",
      id,
      name: optStr(doc.name),
      parameters: parseParameters(doc.parameters, filePath),
      steps: parseSteps(doc.steps, "steps", filePath),
      filePath,
    };
    return m;
  }
  throw new FormatError(
    `unknown fileType ${JSON.stringify(fileType)} (expected memento/test/v1 or memento/module/v1)`,
    filePath,
  );
}

function parseParameters(raw: unknown, filePath: string): ModuleParameter[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new FormatError("`parameters` must be a list", filePath);
  return raw.map((p) => {
    if (typeof p === "string") return { name: p };
    if (!isObj(p) || !p.name) throw new FormatError("each parameter needs a `name`", filePath);
    return {
      name: String(p.name),
      default: p.default == null ? undefined : parseValueExpr(p.default),
      enum: Array.isArray(p.enum) ? p.enum.map(String) : undefined,
    };
  });
}

export function parseValueExpr(v: unknown): ValueExpr {
  if (isObj(v)) {
    if ("string" in v) return { string: String(v.string) };
    if ("javascript" in v) return { javascript: String(v.javascript) };
  }
  // Shorthand strings are JavaScript expressions (same convention as Momentic).
  return { javascript: String(v) };
}

export function parseSteps(raw: unknown, where: string, filePath?: string): Step[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new FormatError(`\`${where}\` must be a list of steps`, filePath);
  return raw.map((s, i) => parseStep(s, `${where}[${i}]`, filePath));
}

export function parseStep(raw: unknown, where = "step", filePath?: string): Step {
  const fail = (msg: string): never => {
    throw new FormatError(`${where}: ${msg}`, filePath);
  };

  if (typeof raw === "string") {
    const s = raw.trim();
    if (BARE_COMMANDS[s]) return BARE_COMMANDS[s]();
    // A multi-word string is an AI action goal. A single unknown word is an error,
    // so typos like `- refesh` don't silently become AI actions.
    if (/\s/.test(s)) return { cmd: "act", goal: s };
    return fail(`unknown command ${JSON.stringify(s)}`);
  }
  if (!isObj(raw)) return fail("a step must be a string or a mapping");

  const keys = Object.keys(raw);
  if (keys.length !== 1) {
    return fail(
      `a step must have exactly one command key, got ${JSON.stringify(keys)}. ` +
        "Put options under the command key, e.g. `click: { on: Submit, retries: 1 }`.",
    );
  }
  const key = keys[0];
  const payload = raw[key];
  const opts = isObj(payload) ? payload : {};
  const common = pickCommon(opts);
  const scalar = isObj(payload) ? undefined : payload == null ? undefined : String(payload);

  const target = (field: string | string[], required = true): Target | undefined => {
    const fields = Array.isArray(field) ? field : [field];
    if (scalar !== undefined) return parseTarget(scalar);
    for (const f of fields) if (opts[f] != null) return parseTarget(opts[f]);
    // Allow the target fields to sit directly in the options (`click: { css: "..." }`).
    if (opts.css || opts.xpath || opts.coords || opts.description) return parseTarget(opts);
    if (required) fail(`\`${key}\` needs a target (${fields.join(" / ")})`);
    return undefined;
  };
  const str = (field: string, required = true): string => {
    if (scalar !== undefined) return scalar;
    const v = opts[field];
    if (v == null) {
      if (required) fail(`\`${key}\` needs \`${field}\``);
      return "";
    }
    return String(v);
  };

  // Soft aliases: softAssert, softCheckElementVisible, ...
  if (key.startsWith("soft") && key.length > 4) {
    const inner = key[4].toLowerCase() + key.slice(5);
    const step = parseStep({ [inner]: payload }, where, filePath);
    return { ...step, soft: true };
  }

  switch (key) {
    case "act":
      return {
        ...common,
        cmd: "act",
        goal: scalar ?? str("goal"),
        precondition: optStr(opts.precondition),
        postcondition: optStr(opts.postcondition),
        maxSteps: typeof opts.maxSteps === "number" ? opts.maxSteps : undefined,
      };
    case "assert":
      return { ...common, cmd: "assert", that: str("that") };
    case "assertVisually":
      return { ...common, cmd: "assert", that: str("that"), visual: true };
    case "extract":
      return { ...common, cmd: "extract", goal: str("goal"), schema: isObj(opts.schema) ? opts.schema : undefined };

    case "click":
      return { ...common, cmd: "click", target: target("on")! };
    case "doubleClick":
      return { ...common, cmd: "click", target: target("on")!, clickCount: 2 };
    case "rightClick":
      return { ...common, cmd: "click", target: target("on")!, button: "right" };
    case "hover":
      return { ...common, cmd: "hover", target: target("on")! };
    case "focus":
      return { ...common, cmd: "focus", target: target("on")! };
    case "blur":
      return { ...common, cmd: "blur", target: target("on", false) };
    case "dragAndDrop":
      return { ...common, cmd: "dragAndDrop", from: parseTarget(opts.from ?? fail("needs `from`")), to: parseTarget(opts.to ?? fail("needs `to`")) };

    case "type":
    case "fill": {
      const text = scalar ?? str("text");
      const t = scalar !== undefined ? undefined : opts.into != null ? parseTarget(opts.into) : undefined;
      if (key === "fill") return { ...common, cmd: "fill", text, target: t };
      return {
        ...common,
        cmd: "type",
        text,
        target: t,
        clear: opts.clear === undefined ? undefined : opts.clear !== false && opts.clear !== "none",
        pressEnter: opts.pressEnter === true || opts.submit === true,
        delay: typeof opts.delay === "number" ? opts.delay : undefined,
      };
    }
    case "press":
      return { ...common, cmd: "press", keys: scalar ?? str("keys") };
    case "select":
      return { ...common, cmd: "select", option: str("option"), target: parseTarget(opts.from ?? opts.on ?? fail("needs `from`")) };
    case "fileUpload":
      return { ...common, cmd: "fileUpload", path: str("path"), target: opts.on ? parseTarget(opts.on) : undefined };

    case "scrollDown":
    case "scrollUp":
    case "scrollLeft":
    case "scrollRight": {
      const direction = key.slice(6).toLowerCase() as "up" | "down" | "left" | "right";
      const amount = scalar !== undefined ? Number(scalar) : typeof opts.amount === "number" ? opts.amount : undefined;
      return { ...common, cmd: "scroll", direction, amount: Number.isFinite(amount) ? amount : undefined, target: opts.in ? parseTarget(opts.in) : undefined };
    }

    case "navigate":
      return { ...common, cmd: "navigate", url: str("url") };
    case "refresh":
    case "goBack":
    case "goForward":
    case "closeTab":
      return { ...common, cmd: key };
    case "newTab":
      return { ...common, cmd: "newTab", url: str("url") };
    case "switchTab":
      return {
        ...common,
        cmd: "switchTab",
        index: scalar !== undefined && /^\d+$/.test(scalar) ? Number(scalar) : typeof opts.index === "number" ? opts.index : undefined,
        url: scalar !== undefined && !/^\d+$/.test(scalar) ? scalar : optStr(opts.url),
      };

    case "wait":
      return { ...common, cmd: "wait", ms: Number(scalar ?? opts.ms ?? opts.duration ?? fail("needs a duration in ms")) };
    case "waitForUrl":
    case "waitForUrlNotToMatch":
      return { ...common, cmd: "waitForUrl", url: str("url"), match: (opts.match as "substring" | "regex" | "glob") ?? "substring", negate: key === "waitForUrlNotToMatch" };

    case "checkPageContains":
    case "checkPageDoesNotContain":
      return { ...common, cmd: "checkPageContains", text: str("text"), negate: key === "checkPageDoesNotContain" };

    case "checkElementVisible":
    case "checkElementNotVisible":
    case "checkElementExists":
    case "checkElementNotExists":
    case "checkElementEnabled":
    case "checkElementDisabled":
    case "checkElementChecked":
    case "checkElementNotChecked": {
      const suffix = key.slice("checkElement".length);
      const check = (suffix[0].toLowerCase() + suffix.slice(1)) as "visible";
      return { ...common, cmd: "checkElement", target: target(["on", "that"])!, check };
    }
    case "checkElementContent":
    case "checkElementContains":
      return {
        ...common,
        cmd: "checkElementContent",
        target: parseTarget(opts.on ?? fail("needs `on`")),
        value: String(opts.value ?? opts.text ?? fail("needs `value`")),
        mode: (opts.mode as "contains") ?? "contains",
        negate: opts.negate === true,
      };
    case "checkElementAttribute":
      return {
        ...common,
        cmd: "checkElementAttribute",
        target: parseTarget(opts.on ?? fail("needs `on`")),
        attribute: String(opts.attribute ?? fail("needs `attribute`")),
        value: opts.value == null ? undefined : String(opts.value),
        negate: opts.negate === true,
      };

    case "request":
      return { ...common, cmd: "request", url: str("url"), method: optStr(opts.method), headers: isObj(opts.headers) ? (opts.headers as Record<string, string>) : undefined, body: opts.body };
    case "mock":
      return {
        ...common,
        cmd: "mock",
        url: str("url"),
        status: typeof opts.status === "number" ? opts.status : undefined,
        body: opts.body,
        headers: isObj(opts.headers) ? (opts.headers as Record<string, string>) : undefined,
        key: optStr(opts.key),
      };
    case "removeRouteMock":
    case "removeMock":
      return { ...common, cmd: "removeMock", key: str("key") };
    case "header":
      return { ...common, cmd: "header", name: str("name"), value: String(opts.value ?? "") };

    case "cookie":
      return { ...common, cmd: "cookie", value: str("value") };
    case "localStorage":
      return { ...common, cmd: "localStorage", key: str("key"), value: String(opts.value ?? "") };
    case "authSave":
      return { ...common, cmd: "authSave", path: scalar ?? optStr(opts.path) };
    case "authLoad":
      return { ...common, cmd: "authLoad", path: str("path") };
    case "dialog":
      return { ...common, cmd: "dialog", action: (scalar ?? opts.action ?? "accept") === "dismiss" ? "dismiss" : "accept", text: optStr(opts.text) };

    case "javascript":
    case "js":
      return { ...common, cmd: "javascript", code: str("code"), environment: opts.environment === "browser" ? "browser" : "node" };

    case "if": {
      const { condition, rest } = extractCondition(opts, ["then", "else"], where, filePath);
      if (!condition) fail("`if` needs a condition (assert, checkElement…, or javascript)");
      return {
        ...common,
        cmd: "if",
        condition: condition!,
        then: parseSteps(rest.then, `${where}.then`, filePath),
        else: rest.else ? parseSteps(rest.else, `${where}.else`, filePath) : undefined,
      };
    }
    case "while": {
      const { condition, rest } = extractCondition(opts, ["do", "maxIterations"], where, filePath);
      const maxIterations = typeof rest.maxIterations === "number" ? rest.maxIterations : undefined;
      if (!condition && maxIterations == null) fail("`while` needs a condition or `maxIterations`");
      return { ...common, cmd: "while", condition, do: parseSteps(rest.do, `${where}.do`, filePath), maxIterations };
    }
    case "module": {
      const path = scalar ?? str("path");
      const inputs: Record<string, ValueExpr> = {};
      if (isObj(opts.inputs)) for (const [k, v] of Object.entries(opts.inputs)) inputs[k] = parseValueExpr(v);
      return { ...common, cmd: "module", path, inputs };
    }
  }
  return fail(`unknown command \`${key}\``);
}

/** Pull the single condition key out of an `if` / `while` body. */
function extractCondition(opts: Record<string, unknown>, reserved: string[], where: string, filePath?: string) {
  const rest: Record<string, unknown> = {};
  let condition: Step | undefined;
  for (const [k, v] of Object.entries(opts)) {
    if (reserved.includes(k) || (COMMON_KEYS as readonly string[]).includes(k)) {
      rest[k] = v;
      continue;
    }
    if (condition) throw new FormatError(`${where}: only one condition is allowed`, filePath);
    condition = parseStep({ [k]: v }, `${where}.condition`, filePath);
  }
  return { condition, rest };
}

export function parseTarget(v: unknown): Target {
  if (isObj(v)) {
    if (v.css) return { kind: "css", selector: String(v.css) };
    if (v.xpath) return { kind: "xpath", selector: String(v.xpath) };
    if (v.coords) return parseCoords(String(v.coords));
    if (v.description) return { kind: "description", description: String(v.description) };
  }
  return { kind: "description", description: String(v) };
}

function parseCoords(s: string): Target {
  const [x, y] = s.split(",").map((n) => Number(n.trim()));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new FormatError(`invalid coords ${JSON.stringify(s)}`);
  return { kind: "coords", x, y };
}

function pickCommon(o: Record<string, unknown>): StepCommon {
  const c: StepCommon = {};
  if (typeof o.comment === "string") c.comment = o.comment;
  if (o.skipped === true) c.skipped = true;
  if (typeof o.retries === "number") c.retries = o.retries;
  if (typeof o.saveAs === "string") c.saveAs = o.saveAs;
  if (typeof o.timeout === "number") c.timeout = o.timeout;
  if (o.soft === true) c.soft = true;
  if (o.cache === false) c.cache = false;
  return c;
}

function optStr(v: unknown): string | undefined {
  return v == null ? undefined : String(v);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Short human label for a step, used in logs, results and AI trajectories. */
export function describeStep(s: Step): string {
  const t = (x?: Target) =>
    !x ? "" : x.kind === "description" ? x.description : x.kind === "coords" ? `(${x.x}, ${x.y})` : `${x.kind}=${x.selector}`;
  switch (s.cmd) {
    case "act": return `AI action: ${s.goal}`;
    case "assert": return `${s.visual ? "Visual check" : "AI check"}: ${s.that}`;
    case "extract": return `Extract: ${s.goal}`;
    case "click": return `${s.button === "right" ? "Right-click" : s.clickCount === 2 ? "Double-click" : "Click"} ${t(s.target)}`;
    case "hover": return `Hover ${t(s.target)}`;
    case "focus": return `Focus ${t(s.target)}`;
    case "blur": return `Blur ${t(s.target)}`.trim();
    case "dragAndDrop": return `Drag ${t(s.from)} to ${t(s.to)}`;
    case "type": return `Type "${s.text}"${s.target ? ` into ${t(s.target)}` : ""}`;
    case "fill": return `Fill "${s.text}"${s.target ? ` into ${t(s.target)}` : ""}`;
    case "press": return `Press ${s.keys}`;
    case "select": return `Select "${s.option}" from ${t(s.target)}`;
    case "fileUpload": return `Upload ${s.path}`;
    case "scroll": return `Scroll ${s.direction}${s.target ? ` in ${t(s.target)}` : ""}`;
    case "navigate": return `Navigate to ${s.url}`;
    case "newTab": return `Open tab ${s.url}`;
    case "switchTab": return `Switch to tab ${s.index ?? s.url}`;
    case "wait": return `Wait ${s.ms}ms`;
    case "waitForUrl": return `Wait for URL ${s.negate ? "not " : ""}matching ${s.url}`;
    case "checkPageContains": return `Page ${s.negate ? "does not contain" : "contains"} "${s.text}"`;
    case "checkElement": return `Element ${t(s.target)} is ${s.check}`;
    case "checkElementContent": return `Element ${t(s.target)} ${s.negate ? "does not " : ""}${s.mode ?? "contains"} "${s.value}"`;
    case "checkElementAttribute": return `Element ${t(s.target)} has ${s.attribute}${s.value != null ? `=${s.value}` : ""}`;
    case "javascript": return `JavaScript (${s.environment ?? "node"})`;
    case "if": return `If ${describeStep(s.condition)}`;
    case "while": return `While ${s.condition ? describeStep(s.condition) : `(${s.maxIterations}x)`}`;
    case "module": return `Module ${s.path}`;
    case "request": return `${s.method ?? "GET"} ${s.url}`;
    case "mock": return `Mock ${s.url}`;
    default: return s.cmd;
  }
}
