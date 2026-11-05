import { mkdtempSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Runner } from "../src/runner/runner.js";
import { FakeAI } from "./fake-ai.js";

/**
 * Full pipeline against real Chromium and a local fixture app.
 * The model is faked, so this verifies everything around it: snapshotting,
 * element resolution, actions, smart waiting, caching, modules, control flow.
 */
let dir: string;
const executablePath = process.env.MEMENTO_BROWSER_PATH;

function project(files: Record<string, string>, config = "") {
  const d = mkdtempSync(join(tmpdir(), "memento-"));
  cpSync(join(__dirname, "fixtures"), join(d, "fixtures"), { recursive: true });
  writeFileSync(join(d, "memento.config.yaml"), `name: e2e\ntrace: "off"\n${config}`);
  for (const [name, src] of Object.entries(files)) writeFileSync(join(d, name), src.replaceAll("$APP", `file://${join(d, "fixtures/app.html")}`));
  return d;
}

const LOGIN_TEST = `fileType: memento/test/v1
id: login
url: $APP
before:
  - if:
      checkElementVisible: { css: "#banner" }
      then:
        - click: the Accept all button
steps:
  - module:
      path: ./login.module.yaml
      inputs:
        EMAIL: { string: ada@example.com }
  - checkElementVisible: { css: "#dash" }
  - assert: The heading says 'Welcome, ada@example.com'
  - click: the Add to cart button for Gravity Blanket
  - checkElementContent:
      on: { css: "#count" }
      value: "1"
  - extract:
      goal: number of items in the cart
      saveAs: CART
  - javascript:
      code: "if (env.CART !== '1') throw new Error('bad cart ' + env.CART); return env.CART"
  - select:
      option: "Price: low to high"
      from: { css: "#sort" }
  - checkPageContains: Weighted Pillow
`;

const LOGIN_MODULE = `fileType: memento/module/v1
id: login-module
name: Log in
parameters:
  - name: EMAIL
  - name: PASSWORD
    default: { string: secret }
steps:
  - type:
      text: "{{ env.EMAIL }}"
      into: the Email field
  - fill:
      text: "{{ env.PASSWORD }}"
      into: the Password field
  - click: the Remember me checkbox
  - click: the Sign in button
`;

beforeAll(() => {
  dir = project({ "login.test.yaml": LOGIN_TEST, "login.module.yaml": LOGIN_MODULE }, executablePath ? `browser:\n  executablePath: ${executablePath}\n` : "");
});

describe("runner e2e", () => {
  it("runs a test with AI-resolved elements, then replays from cache with no locator calls", async () => {
    const cfg = loadConfig(dir);
    const ai1 = new FakeAI();
    const s1 = await new Runner(cfg).run({ ai: ai1 });
    const r1 = s1.results[0];
    if (r1.status !== "passed") console.log(JSON.stringify(r1, null, 2));
    expect(r1.status).toBe("passed");
    const locatorCalls1 = ai1.calls.filter((c) => c.agent === "locator").length;
    expect(locatorCalls1).toBeGreaterThanOrEqual(5);

    const ai2 = new FakeAI();
    const s2 = await new Runner(cfg).run({ ai: ai2 });
    expect(s2.results[0].status).toBe("passed");
    // Every natural-language locator now hits the cache.
    expect(ai2.calls.filter((c) => c.agent === "locator")).toHaveLength(0);
    expect(s2.results[0].cache.hits).toBeGreaterThanOrEqual(locatorCalls1);
  }, 120_000);

  it("fails with a useful error when an assertion is false", async () => {
    const d = project(
      { "bad.test.yaml": `fileType: memento/test/v1\nid: bad\nurl: $APP\nsteps:\n  - assert: The page shows 'Order confirmed'\n` },
      executablePath ? `browser:\n  executablePath: ${executablePath}\n  elementCheckTimeoutMs: 500\n` : "browser:\n  elementCheckTimeoutMs: 500\n",
    );
    const s = await new Runner(loadConfig(d)).run({ ai: new FakeAI() });
    expect(s.results[0].status).toBe("failed");
    expect(s.results[0].error).toMatch(/Assertion failed/);
    expect(s.results[0].steps[0].screenshot).toBeTruthy();
  }, 60_000);

  it("runs an AI action, caches its trajectory and replays it", async () => {
    const d = project(
      {
        "act.test.yaml": `fileType: memento/test/v1\nid: act\nurl: $APP\nsteps:\n  - act:\n      goal: Dismiss the cookie banner\n      postcondition: The page shows 'Sign in'\n`,
      },
      executablePath ? `browser:\n  executablePath: ${executablePath}\n` : "",
    );
    const cfg = loadConfig(d);
    const ai = new FakeAI();
    // The fake "model" looks up the Accept button id from the snapshot it is shown.
    const orig = ai.generate.bind(ai);
    ai.generate = async (req) => {
      if (req.agent === "act") {
        const text = req.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        const id = Number(text.match(/\[(\d+)\] button "Accept all"/)?.[1] ?? -1);
        ai.actScript = [
          id >= 0
            ? { thought: "banner visible", plan: ["accept"], action: { type: "click", elementId: id, description: "the Accept all button in the cookie banner" } }
            : { thought: "done", plan: [], action: { type: "finish", success: true, message: "banner gone", postcondition: null } },
        ];
      }
      return orig(req);
    };
    const s1 = await new Runner(cfg).run({ ai });
    expect(s1.results[0].status).toBe("passed");
    expect(s1.results[0].steps[0].children).toHaveLength(1);

    const ai2 = new FakeAI();
    const s2 = await new Runner(cfg).run({ ai: ai2 });
    expect(s2.results[0].status).toBe("passed");
    expect(s2.results[0].steps[0].resolution).toBe("cache");
    expect(ai2.calls.filter((c) => c.agent === "act")).toHaveLength(0);
  }, 120_000);
});
