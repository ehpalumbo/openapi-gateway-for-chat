# Phase 2 — Registration & Persistence

## Overview

This phase makes APIs registrable and durable: a size-limited HTTP fetcher, the `globalState`-backed registry with last-good snapshots (R-REG-5..7), the `SecretStorage` token store (R-AUTH-*), the four user-facing commands (R-REG-1..3, 6, 8, 9), activation refresh, and `package.json` command contributions. After this phase a user can register, list, refresh, and unregister APIs across window reloads; tools come in Phase 3.

## Task Details

### 1. Implement size-limited HTTP fetching

- **Prerequisites / Dependencies:** None.
- **Affected Files:**
  - [http.ts](../../src/vscode/http.ts) (new)
- **Affected Symbols:** `fetchWithLimit(url: string, maxBytes: number): Promise<{ text: string; finalUrl: string }>`
- **Description:** Use global `fetch`. Validate protocol is `http`/`https` before requesting (NFR-2). Enforce the byte cap on both `Content-Length` and accumulated chunk reads while streaming the body; abort with an actionable error past the cap. Follow redirects but return the final URL.
- **Acceptance Criteria:**
  - [ ] Requests to non-http(s) URLs fail before any network call.
  - [ ] A response larger than `maxBytes` aborts with a size-limit error.
  - [ ] Unit-testable via injected fetch? — no; covered by integration test against a local server in Task 7.

### 2. Implement the API registry store

- **Prerequisites / Dependencies:** Task 1 of Phase 1 (types).
- **Affected Files:**
  - [registry.ts](../../src/store/registry.ts) (new)
- **Affected Symbols:** `ApiRegistry` (`load`, `save`, `upsert`, `remove`, `list`, `get`, `has`), runtime view `{ registration, model, index }`
- **Description:** Wrap a `vscode.Memento` (passed in as `vscode.Memento`, stored under key `registeredApis`). Keep registrations as `ApiRegistration[]`; `snapshot.model` holds the last successfully parsed, grouped API model so failures at refresh time never destroy usability (R-REG-7). Maintain an in-memory per-API runtime view — `Map<apiId, { registration, model, index }>` where `index = buildOperationIndex(model)` (see phase 1 refinement) — rebuilt on every mutation (`upsert`, `remove`, refresh) so the derived index can never drift from the persisted model. Operation IDs are unique within an API only; never flatten indices across APIs. `upsert` rejects duplicate `apiId` by returning a typed conflict result the caller resolves by prompting (R-REG-8).
- **Acceptance Criteria:**
  - [ ] Two `ApiRegistry` instances over the same memento see the same data (persistence semantics testable without window reload).
  - [ ] After any mutation, the in-memory index resolves exactly the operations present in `snapshot.model` (no drift).
  - [ ] `upsert` with existing `apiId` returns conflict and does not mutate state.

### 3. Implement the token secret store

- **Prerequisites / Dependencies:** None.
- **Affected Files:**
  - [secrets.ts](../../src/store/secrets.ts) (new)
- **Affected Symbols:** `TokenStore` (`setToken`, `deleteToken`, `getToken`)
- **Description:** Thin wrapper over `vscode.SecretStorage` keyed by `apiId:<apiId>`. Tokens are written nowhere else — no logging, no results, no settings (R-AUTH-2, NFR-1).
- **Acceptance Criteria:**
  - [ ] Round-trip set/get/delete works for a key.
  - [ ] No code path serializes token values into memento/settings/log calls.

### 4. Implement registration commands

- **Prerequisites / Dependencies:** Tasks 1–3.
- **Affected Files:**
  - [commands/common.ts](../../src/vscode/commands/common.ts) (new) — shared `CommandContext`, spec loading/parsing helpers, pure suggestion helpers
  - [commands/register.ts](../../src/vscode/commands/register.ts), [commands/unregister.ts](../../src/vscode/commands/unregister.ts), [commands/refresh.ts](../../src/vscode/commands/refresh.ts) (new) — one module per command exporting a plain handler `(ctx: CommandContext) => …`
  - [commands/index.ts](../../src/vscode/commands/index.ts) (new) — the only place binding handlers to VS Code command IDs via `vscode.commands.registerCommand`
- **Affected Symbols:** `registerApiCommands(ctx: { registry: ApiRegistry; tokens: TokenStore; onChange: () => void })` in `index.ts`; per-module handlers `registerFromUrlHandler`, `registerFromFileHandler`, `unregisterApiHandler`, `refreshApisHandler`; test-facing helpers in `common.ts` (`buildSnapshot`, `createRegistration`, `loadSpecFromSource`, `resolveBaseUrlSuggestion`) and `refreshAll` in `refresh.ts`
- **Description:** Four commands:
  - `openapi-gateway-for-chat.registerFromUrl` (R-REG-1): URL input box → `fetchWithLimit` → `parseSpec` → prompt unique `apiId` (prefill from title slug; re-prompt on conflict) → confirm base URL: QuickPick when multiple `servers`, then an always-shown editable InputBox pre-filled with the suggestion so placeholder URIs can be overridden (R-REG-9) → optional password InputBox for Bearer token → `tokens.setToken` if provided → `upsert`.
  - `openapi-gateway-for-chat.registerFromFile` (R-REG-2): `showOpenDialog` filtered to `.json` → read file → same flow as above minus fetch.
  - `openapi-gateway-for-chat.unregisterApi` (R-REG-3): QuickPick of registered APIs → confirm → `remove` + `deleteToken`.
  - `openapi-gateway-for-chat.refreshApis` (R-REG-6): re-fetch each URL registration / re-read each file registration sequentially; on failure keep snapshot, collect errors, surface once via `showWarningMessage` without blocking other registrations (R-REG-7).
  Command handlers are pure context-consuming functions (no `vscode.commands` calls in their modules) so integration tests can invoke them directly; `index.ts` performs all registration wiring.
  All handlers invoke `onChange()` after mutation so tools re-register later. Reject YAML files with the actionable JSON-only message.
- **Acceptance Criteria:**
  - [ ] Registering the same `apiId` twice prompts instead of silently overwriting (R-REG-8).
  - [ ] A multi-server spec shows a selection picker; a single-server spec still shows a pre-filled confirmation prompt; the confirmed value becomes `baseUrl`.
  - [ ] Refresh with an unreachable URL keeps the old snapshot usable and reports the failure; other APIs still refresh.
  - [ ] Token entry uses `password: true` input and lands only in `SecretStorage`.

### 5. Wire activation

- **Prerequisites / Dependencies:** Task 4.
- **Affected Files:**
  - [extension.ts](../../src/extension.ts) (modify), [package.json](../../package.json) (modify)
- **Affected Symbols:** `activate`
- **Description:** Replace hello-world scaffold. On activate: create `ApiRegistry(context.globalState)` + `TokenStore(context.secrets)`; run refresh logic once (same code path as the refresh command); register commands into `context.subscriptions`; call a stubbed `registerGatewayTools(...)` (Phase 3) guarded so this phase compiles standalone — e.g., accept an optional callback that is a no-op until Phase 3 lands. Contribute all four commands plus titles in `contributes.commands`.
- **Acceptance Criteria:**
  - [ ] Extension activates on any contributed command (`activationEvents` auto-derived) or startup per VS Code defaults.
  - [ ] Registrations survive `workbench.action.reloadWindow` (manual F5 check).
  - [ ] Hello-world command is removed from contributions and code.

### 6. Add configuration contribution

- **Prerequisites / Dependencies:** None (needed by Phase 5 but trivially additive here).
- **Affected Files:**
  - [package.json](../../package.json) (modify)
- **Description:** `contributes.configuration` with `openapiGateway.inlineResponseThreshold`: type number, default `8192`, scope `application`, description stating bytes.
- **Acceptance Criteria:**
  - [ ] Setting appears under the extension's settings section with default 8192.

### 7. Integration-test registration flows

- **Prerequisites / Dependencies:** Tasks 1–5.
- **Affected Files:**
  - [registration.test.ts](../../src/test/registration.test.ts) (new), [fixtures/petstore30.json](../../src/test/fixtures/petstore30.json) (new), [fixtures/multiserver31.json](../../src/test/fixtures/multiserver31.json) (new), [fixtures/swagger20.json](../../src/test/fixtures/swagger20.json) (new)
- **Description:** Start an ephemeral `node:http` server inside the suite to serve fixture specs and simulate oversize responses (verifies Task 1). Exercise: successful URL registration end-to-end through the command handler function (invoked directly, not via UI); version/YAML rejection messages; persistence across a fresh `ApiRegistry` bound to the shared globalState; conflict detection; refresh-failure snapshot retention.
- **Acceptance Criteria:**
  - [ ] Registration via served URL yields a persisted `ApiRegistration` with parsed operations count > 0.
  - [ ] Oversize fetch aborts with the size-limit error message.
  - [ ] Failed refresh leaves prior snapshot intact and other APIs updated.

## Verification Plan

1. `npm run compile && npm test` — clean, new suites pass.
2. F5 → run **OpenAPI Gateway: Register API from File** on `petstore30.json`; verify prompts sequence and success toast.
3. Reload window → run a listing check (temporary log or debug inspect) confirming the registration survived.
4. Stop local server, run **Refresh**, verify warning surfaces and old data still present.
