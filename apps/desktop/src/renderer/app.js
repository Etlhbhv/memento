// Renderer: plain DOM, no framework. All privileged work goes through window.memento (preload).
const api = window.memento;
const $ = (id) => document.getElementById(id);
const AGENTS = ["default", "locator", "assertion", "extract", "act", "review", "recovery"];

const state = { project: null, tests: [], current: null, dirty: false, running: false, runEls: new Map() };

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

// ------------------------------------------------------------- project / tests

async function openProject(dir) {
  const r = await api.openProject(dir);
  if (!r) return;
  state.project = r.dir;
  localStorage.setItem("lastProject", r.dir);
  $("projectPath").textContent = r.dir;
  for (const b of ["settingsBtn", "runAll", "newTest"]) $(b).disabled = false;
  await refreshTests();
}

async function refreshTests() {
  try {
    state.tests = await api.listTests();
  } catch (e) {
    state.tests = [];
    alert(e.message);
  }
  const list = $("testList");
  list.replaceChildren();
  for (const t of state.tests) {
    const li = el("li", { onclick: () => selectTest(t.file) }, el("span", {}, t.id, el("span", { class: "file" }, t.file)));
    if (state.current === t.file) li.classList.add("active");
    list.append(li);
  }
  if (!state.tests.length) list.append(el("li", { class: "muted" }, "No tests yet — click + New."));
}

async function selectTest(file) {
  if (state.dirty && !confirm("Discard unsaved changes?")) return;
  state.current = file;
  $("editor").value = await api.readFile(file);
  $("editor").disabled = false;
  $("editorFile").textContent = file;
  $("saveTest").disabled = false;
  $("runTest").disabled = state.running;
  state.dirty = false;
  validate();
  refreshTests();
}

let validateTimer;
async function validate() {
  if (!state.current) return;
  const err = await api.validate(state.current, $("editor").value);
  const v = $("validation");
  v.textContent = err ? err.split(": ").slice(1).join(": ") || err : state.dirty ? "unsaved" : "valid";
  v.className = err ? "bad" : "ok";
}

async function save() {
  if (!state.current) return;
  try {
    await api.writeFile(state.current, $("editor").value);
    state.dirty = false;
    validate();
    refreshTests();
  } catch (e) {
    alert(e.message);
  }
}

async function newTest() {
  const id = prompt("Test id (kebab-case):", "my-new-test");
  if (!id) return;
  const file = `tests/${id}.test.yaml`;
  const body = `fileType: memento/test/v1\nid: ${id}\nurl: https://example.com\nsteps:\n  - assert: The page shows 'Example Domain'\n`;
  await api.writeFile(file, body);
  await refreshTests();
  selectTest(file);
}

// ------------------------------------------------------------- runs

function setRunning(on) {
  state.running = on;
  $("runAll").disabled = on;
  $("runTest").disabled = on || !state.current;
  $("stopRun").hidden = !on;
}

async function run(paths) {
  if (state.dirty) await save();
  $("runOutput").replaceChildren();
  state.runEls.clear();
  setRunning(true);
  try {
    await api.run({ paths, headed: $("headed").checked, disableCache: $("noCache").checked });
  } catch (e) {
    $("runOutput").append(el("p", { class: "st-failed" }, e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")));
  } finally {
    setRunning(false);
  }
}

function testBox(testId, file) {
  let box = state.runEls.get(testId);
  if (!box) {
    const status = el("span", { class: "st-running" }, "●");
    const meta = el("span", { class: "muted" });
    const steps = el("ul", { class: "run-steps" });
    const actions = el("span");
    const root = el("div", { class: "run-test" }, el("div", { class: "run-test-head" }, status, el("strong", {}, file || testId), el("span", { class: "spacer" }), meta, actions), steps);
    $("runOutput").append(root);
    box = { root, status, meta, steps, actions, rows: new Map() };
    state.runEls.set(testId, box);
  }
  return box;
}

const ICONS = { passed: "✓", failed: "✘", skipped: "○", softFailed: "!", running: "●" };

api.onRunEvent(({ channel, payload }) => {
  switch (channel) {
    case "run:start":
      for (const t of payload.tests) testBox(t.id, t.file);
      break;
    case "step:start": {
      if (payload.path.includes(".ai[")) break;
      const box = testBox(payload.testId);
      const row = el("li", {}, el("span", { class: "st-running" }, ICONS.running), el("span", {}, payload.label));
      box.steps.append(row);
      box.rows.set(payload.path, row);
      break;
    }
    case "step:end": {
      const r = payload.result;
      if (r.path.includes(".ai[")) break;
      const box = testBox(payload.testId);
      const row = box.rows.get(r.path) ?? el("li");
      const parts = [el("span", { class: `st-${r.status}` }, ICONS[r.status] ?? "?"), el("span", {}, r.label)];
      if (r.resolution === "cache") parts.push(el("span", { class: "tag" }, "cache"));
      if (r.resolution === "ai") parts.push(el("span", { class: "tag ai" }, "AI"));
      if (r.resolution === "healed") parts.push(el("span", { class: "tag healed" }, "healed"));
      if (r.recovered) parts.push(el("span", { class: "tag healed" }, "recovered"));
      parts.push(el("span", { class: "spacer" }), el("span", { class: "muted" }, `${r.durationMs}ms`));
      row.replaceChildren(...parts);
      if (r.error && r.status !== "passed") row.after(el("div", { class: "err" }, r.error));
      break;
    }
    case "test:end": {
      const box = testBox(payload.testId, payload.file);
      box.status.className = `st-${payload.status}`;
      box.status.textContent = ICONS[payload.status];
      box.meta.textContent = `${(payload.durationMs / 1000).toFixed(1)}s · ${payload.ai.calls} AI · cache ${payload.cache.hits}/${payload.cache.hits + payload.cache.misses}`;
      if (payload.trace) box.actions.replaceChildren(el("button", { class: "small", onclick: () => api.openTrace(payload.trace) }, "Trace"));
      break;
    }
    case "run:end":
      $("runOutput").append(el("p", { class: payload.failed ? "st-failed" : "st-passed" }, `${payload.passed} passed, ${payload.failed} failed in ${(payload.durationMs / 1000).toFixed(1)}s`));
      break;
  }
});

// ------------------------------------------------------------- settings

function providerRow(name = "", p = {}) {
  const row = $("providerTpl").content.firstElementChild.cloneNode(true);
  row.querySelector(".p-name").value = name;
  row.querySelector(".p-type").value = p.type ?? "anthropic";
  row.querySelector(".p-base").value = p.baseURL ?? "";
  const keyRef = typeof p.apiKey === "string" ? (p.apiKey.match(/^\$\{([A-Z0-9_]+)\}$/)?.[1] ?? "") : "";
  row.querySelector(".p-keyvar").value = keyRef;
  row.querySelector(".p-vision").checked = p.vision !== false;
  row.querySelector(".p-remove").onclick = () => row.remove();
  $("providers").append(row);
}

async function openSettings() {
  const { ai, secrets } = await api.getSettings();
  $("providers").replaceChildren();
  for (const [name, p] of Object.entries(ai.providers ?? {})) providerRow(name, p);
  if (!Object.keys(ai.providers ?? {}).length) providerRow("anthropic", { type: "anthropic", apiKey: "${ANTHROPIC_API_KEY}" });
  for (const row of $("providers").children) {
    const v = row.querySelector(".p-keyvar").value;
    if (v && secrets.includes(v)) row.querySelector(".p-key").placeholder = "stored in keychain ✓ (paste to replace)";
  }
  const models = $("models");
  models.replaceChildren();
  for (const a of AGENTS) {
    const cur = ai.models?.[a];
    models.append(el("label", {}, a), el("input", { id: `model-${a}`, value: Array.isArray(cur) ? cur.join(", ") : (cur ?? ""), placeholder: a === "default" ? "anthropic:claude-sonnet-5-5" : "(uses default)" }));
  }
  $("vision").checked = ai.vision !== false;
  $("failureRecovery").checked = !!ai.failureRecovery;
  $("settings").showModal();
}

async function saveSettings(e) {
  e.preventDefault();
  const providers = {};
  for (const row of $("providers").children) {
    const name = row.querySelector(".p-name").value.trim();
    if (!name) continue;
    const keyVar = row.querySelector(".p-keyvar").value.trim();
    const key = row.querySelector(".p-key").value;
    if (keyVar && key) await api.setSecret(keyVar, key);
    providers[name] = { type: row.querySelector(".p-type").value };
    const base = row.querySelector(".p-base").value.trim();
    if (base) providers[name].baseURL = base;
    if (keyVar) providers[name].apiKey = `\${${keyVar}}`;
    if (!row.querySelector(".p-vision").checked) providers[name].vision = false;
  }
  const models = {};
  for (const a of AGENTS) {
    const v = $(`model-${a}`).value.split(",").map((s) => s.trim()).filter(Boolean);
    if (v.length) models[a] = v.length === 1 ? v[0] : v;
  }
  try {
    await api.saveAi({ providers, models, vision: $("vision").checked, failureRecovery: $("failureRecovery").checked });
    $("settings").close();
  } catch (err) {
    alert(err.message);
  }
}

// ------------------------------------------------------------- wiring

$("openProject").onclick = () => openProject();
$("newTest").onclick = newTest;
$("saveTest").onclick = save;
$("runTest").onclick = () => state.current && run([state.current]);
$("runAll").onclick = () => run();
$("stopRun").onclick = () => api.stop();
$("settingsBtn").onclick = openSettings;
$("addProvider").onclick = () => providerRow();
$("saveSettings").onclick = saveSettings;
$("editor").addEventListener("input", () => {
  state.dirty = true;
  clearTimeout(validateTimer);
  validateTimer = setTimeout(validate, 300);
});
$("editor").addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    document.execCommand("insertText", false, "  ");
  }
});
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
    save();
  }
});

(async () => {
  const initial = (await api.initialProject()) ?? localStorage.getItem("lastProject");
  if (initial) openProject(initial).catch(() => localStorage.removeItem("lastProject"));
})();
