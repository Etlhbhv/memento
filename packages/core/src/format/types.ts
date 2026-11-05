/**
 * Normalized, in-memory representation of Memento tests.
 *
 * On disk, tests are YAML (`*.test.yaml`) with a compact authoring syntax
 * (see `parse.ts`). The parser turns every authoring shorthand into one of the
 * explicit shapes below so the runner only ever deals with one form.
 */

/** How a step identifies the element it acts on. */
export type Target =
  | { kind: "description"; description: string }
  | { kind: "css"; selector: string }
  | { kind: "xpath"; selector: string }
  | { kind: "coords"; x: number; y: number };

/** A value passed to a module input: a literal string or a JS expression. */
export type ValueExpr = { string: string } | { javascript: string };

export interface StepCommon {
  /** Free-form comment, shown in results. */
  comment?: string;
  /** Skip the step without failing. */
  skipped?: boolean;
  /** Retry the step this many extra times on failure. */
  retries?: number;
  /** Write the step's return value to `env[saveAs]`. */
  saveAs?: string;
  /** Per-step timeout in ms (meaning depends on the command). */
  timeout?: number;
  /** Soft assertions record a failure but let the test continue. */
  soft?: boolean;
  /** Disable the step cache for this step. */
  cache?: boolean;
}

export type Step = StepCommon & StepBody;

export type StepBody =
  // AI
  | { cmd: "act"; goal: string; precondition?: string; postcondition?: string; maxSteps?: number }
  | { cmd: "assert"; that: string; visual?: boolean }
  | { cmd: "extract"; goal: string; schema?: Record<string, unknown> }
  // Mouse
  | { cmd: "click"; target: Target; button?: "left" | "right" | "middle"; clickCount?: number; modifiers?: string[] }
  | { cmd: "hover"; target: Target }
  | { cmd: "focus"; target: Target }
  | { cmd: "blur"; target?: Target }
  | { cmd: "dragAndDrop"; from: Target; to: Target }
  // Keyboard / form
  | { cmd: "type"; text: string; target?: Target; clear?: boolean; pressEnter?: boolean; delay?: number }
  | { cmd: "fill"; text: string; target?: Target }
  | { cmd: "press"; keys: string }
  | { cmd: "select"; option: string; target: Target }
  | { cmd: "fileUpload"; path: string; target?: Target }
  // Scroll
  | { cmd: "scroll"; direction: "up" | "down" | "left" | "right"; amount?: number; target?: Target }
  // Navigation
  | { cmd: "navigate"; url: string }
  | { cmd: "refresh" }
  | { cmd: "goBack" }
  | { cmd: "goForward" }
  | { cmd: "newTab"; url: string }
  | { cmd: "switchTab"; index?: number; url?: string }
  | { cmd: "closeTab" }
  // Waits
  | { cmd: "wait"; ms: number }
  | { cmd: "waitForUrl"; url: string; match?: "substring" | "regex" | "glob"; negate?: boolean }
  // Page / element checks (deterministic, no AI needed for css targets)
  | { cmd: "checkPageContains"; text: string; negate?: boolean }
  | {
      cmd: "checkElement";
      target: Target;
      check: "visible" | "notVisible" | "exists" | "notExists" | "enabled" | "disabled" | "checked" | "notChecked";
    }
  | { cmd: "checkElementContent"; target: Target; value: string; mode?: "contains" | "equals" | "regex"; negate?: boolean }
  | { cmd: "checkElementAttribute"; target: Target; attribute: string; value?: string; negate?: boolean }
  // Network
  | { cmd: "request"; url: string; method?: string; headers?: Record<string, string>; body?: unknown }
  | { cmd: "mock"; url: string; status?: number; body?: unknown; headers?: Record<string, string>; key?: string }
  | { cmd: "removeMock"; key: string }
  | { cmd: "header"; name: string; value: string }
  // Storage / auth
  | { cmd: "cookie"; value: string }
  | { cmd: "localStorage"; key: string; value: string }
  | { cmd: "authSave"; path?: string }
  | { cmd: "authLoad"; path: string }
  | { cmd: "dialog"; action: "accept" | "dismiss"; text?: string }
  // Code
  | { cmd: "javascript"; code: string; environment?: "node" | "browser" }
  // Control flow
  | { cmd: "if"; condition: Step; then: Step[]; else?: Step[] }
  | { cmd: "while"; condition?: Step; do: Step[]; maxIterations?: number }
  | { cmd: "module"; path: string; inputs?: Record<string, ValueExpr> };

export type StepCmd = StepBody["cmd"];

export interface ModuleParameter {
  name: string;
  default?: ValueExpr;
  enum?: string[];
}

export interface TestFile {
  kind: "test";
  id: string;
  description?: string;
  url?: string;
  labels?: string[];
  disabled?: boolean;
  retries?: number;
  before: Step[];
  steps: Step[];
  after: Step[];
  /** Statements that must have been true at some point during the run. */
  runAssertions: string[];
  /** Absolute path of the YAML file. */
  filePath: string;
}

export interface ModuleFile {
  kind: "module";
  id: string;
  name?: string;
  parameters: ModuleParameter[];
  steps: Step[];
  filePath: string;
}

export type MementoFile = TestFile | ModuleFile;
