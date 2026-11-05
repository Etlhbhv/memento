import { describe, expect, it } from "vitest";
import { parseFile, parseStep } from "../src/format/parse.js";
import { interpolate } from "../src/runner/script.js";
import { globToRegExp } from "../src/runner/runner.js";

describe("step parsing", () => {
  it("treats multi-word strings as AI actions and one-word strings as commands", () => {
    expect(parseStep("Add a blanket to the cart")).toEqual({ cmd: "act", goal: "Add a blanket to the cart" });
    expect(parseStep("refresh")).toEqual({ cmd: "refresh" });
    expect(() => parseStep("refesh")).toThrow(/unknown command/);
  });

  it("parses shorthand and detailed forms", () => {
    expect(parseStep({ click: "Submit" })).toEqual({ cmd: "click", target: { kind: "description", description: "Submit" } });
    expect(parseStep({ click: { on: "Submit", retries: 2 } })).toMatchObject({ cmd: "click", retries: 2 });
    expect(parseStep({ click: { css: "#go" } })).toMatchObject({ target: { kind: "css", selector: "#go" } });
    expect(parseStep({ click: { coords: "10, 20" } })).toMatchObject({ target: { kind: "coords", x: 10, y: 20 } });
    expect(parseStep({ type: { text: "hi", into: "Email" } })).toMatchObject({ cmd: "type", text: "hi", target: { description: "Email" } });
    expect(parseStep({ doubleClick: "Row" })).toMatchObject({ cmd: "click", clickCount: 2 });
  });

  it("rejects sibling options beside a scalar command", () => {
    expect(() => parseStep({ click: "Submit", retries: 1 })).toThrow(/exactly one command key/);
  });

  it("parses soft aliases, element checks and act options", () => {
    expect(parseStep({ softAssert: "Cart is empty" })).toMatchObject({ cmd: "assert", soft: true });
    expect(parseStep({ checkElementVisible: "the logo" })).toMatchObject({ cmd: "checkElement", check: "visible" });
    expect(parseStep({ act: { goal: "Log in", postcondition: "Dashboard shown", cache: false } })).toMatchObject({
      cmd: "act",
      goal: "Log in",
      postcondition: "Dashboard shown",
      cache: false,
    });
  });

  it("parses control flow with inline conditions", () => {
    const s = parseStep({ if: { checkElementVisible: "the cookie banner", then: [{ click: "Accept all" }] } });
    expect(s).toMatchObject({ cmd: "if", condition: { cmd: "checkElement" }, then: [{ cmd: "click" }] });
    const w = parseStep({ while: { assert: "A Load more button is visible", maxIterations: 3, do: [{ click: "Load more" }] } });
    expect(w).toMatchObject({ cmd: "while", maxIterations: 3, condition: { cmd: "assert" } });
    expect(() => parseStep({ while: { do: [] } })).toThrow(/condition or `maxIterations`/);
  });

  it("parses modules and inputs", () => {
    const s = parseStep({ module: { path: "./login.module.yaml", inputs: { USER: { string: "a" }, PW: "env.PW" } } });
    expect(s).toMatchObject({ cmd: "module", inputs: { USER: { string: "a" }, PW: { javascript: "env.PW" } } });
  });
});

describe("files", () => {
  it("parses a test file and accepts Momentic v2 files", () => {
    const src = `fileType: momentic/test/v2\nid: checkout\nurl: https://x.test\nsteps:\n  - click: Checkout\n  - assert: Order confirmed\n`;
    const f = parseFile("/tmp/checkout.test.yaml", src);
    expect(f).toMatchObject({ kind: "test", id: "checkout", url: "https://x.test" });
    if (f.kind === "test") expect(f.steps).toHaveLength(2);
  });

  it("requires an id and known fileType", () => {
    expect(() => parseFile("/x.yaml", "fileType: memento/test/v1\nsteps: []")).toThrow(/missing `id`/);
    expect(() => parseFile("/x.yaml", "fileType: nope\nid: a")).toThrow(/unknown fileType/);
  });
});

describe("templating", () => {
  it("interpolates env expressions and helpers", () => {
    expect(interpolate("Hi {{ env.NAME }}!", { NAME: "Ada" })).toBe("Hi Ada!");
    expect(interpolate("{{ env.N + 1 }}", { N: 1 })).toBe("2");
    expect(interpolate("{{ randomEmail() }}", {})).toMatch(/@example\.com$/);
  });
});

describe("globs", () => {
  it("matches test globs", () => {
    expect(globToRegExp("**/*.test.yaml").test("a/b/c.test.yaml")).toBe(true);
    expect(globToRegExp("**/*.test.yaml").test("c.test.yaml")).toBe(true);
    expect(globToRegExp("**/node_modules/**").test("x/node_modules/y/z.test.yaml")).toBe(true);
    expect(globToRegExp("tests/*.test.yaml").test("tests/sub/a.test.yaml")).toBe(false);
  });
});
