# Roadmap and Momentic parity

Phase 1 is web-only parity with Momentic's repository-test product, then
Memento-specific features on top. ✅ done · 🟡 partial · ⬜ not started.

## Test format and steps

| Feature | Status | Notes |
| - | - | - |
| YAML tests/modules, `before`/`steps`/`after` | ✅ | `memento/test/v1`; also reads `momentic/test/v2` files |
| Bare-string AI actions, shorthand/detailed steps | ✅ | |
| Click / double / right / hover / focus / blur / drag | ✅ | `mouseDrag` ⬜ |
| Type / fill / press / select / file upload | ✅ | `keyDown`/`keyUp`, `copy`/`paste` ⬜ |
| Scroll (page or container) | ✅ | |
| Navigate / refresh / back / forward / tabs | ✅ | |
| Waits (`wait`, `waitForUrl`, not-match) | ✅ | |
| Page checks, element checks, soft checks | ✅ | `checkElementStyle`, `checkElementName` ⬜ |
| `assert`, `assertVisually`, `extract` | ✅ | |
| `act` with pre/postcondition, cached trajectory, heal | ✅ | |
| `if` (+ `else`, which Momentic lacks), `while` | ✅ | |
| Modules with parameters/defaults/enums | ✅ | module result caching / `autoAuth` ⬜ |
| JavaScript (node / browser), templating, `saveAs` | ✅ | faker ⬜ (built-in helpers instead) |
| Network: request, mock, header | ✅ | GraphQL, request recording/listeners ⬜ |
| Cookies, localStorage, authSave/authLoad, dialogs | ✅ | |
| Run assertions (video frames) | ⬜ | |
| Visual diff vs golden files | ⬜ | |
| Email / SMS inboxes | ⬜ | Plug-in providers (Mailpit, Mailosaur, Twilio) |

## AI and reliability

| Feature | Status | Notes |
| - | - | - |
| Locator agent with signal classification | ✅ | |
| Step cache: multi-selector voting + signal validation | ✅ | branch-aware isolation ⬜ |
| Locator auto-heal | ✅ | |
| Smart waiting (network + DOM quiet) | ✅ | |
| Hidden-input → label redirect | 🟡 | basic version |
| Failure recovery (≤3 per run) | ✅ | opt-in `ai.failureRecovery` |
| Knowledge base (terms, rules, flows) | ✅ | lexical retrieval; embeddings ⬜ |
| Memory of past decisions | ⬜ | |
| Effort routing (cheap vs strong model per query) | ⬜ | per-agent model choice exists today |
| Failure classification | ⬜ | |
| Triage / permanent healing (propose YAML diffs) | ⬜ | |
| Quarantine | ⬜ | |
| AI test selection from a diff | ⬜ | |

## Tooling

| Feature | Status | Notes |
| - | - | - |
| CLI: init, run, list, doctor, trace | ✅ | |
| Parallel workers, retries, labels, environments | ✅ | sharding ⬜ |
| Playwright traces, screenshots on failure, video | ✅ | |
| JUnit / Allure reports | ⬜ | JSON summary today |
| MCP server for coding agents | ⬜ | |
| Coding-agent skills | ⬜ | |
| Import from Playwright / Cypress / Selenium | ⬜ | Momentic YAML already loads |
| Desktop app: projects, editor, runs, AI settings, keychain | ✅ | |
| Desktop: visual recorder, step-by-step debugger | ⬜ | |
| Desktop: packaging/signing (dmg, exe) | ⬜ | electron-builder |
| Autonomous explorer ("Mo"-style) | ⬜ | |
| Cloud runners (paid) | ⬜ | `Runner` already takes injectable browser/AI backends |
