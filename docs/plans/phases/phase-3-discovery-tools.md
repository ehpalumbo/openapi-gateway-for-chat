# Phase 3 — Discovery Tools (Progressive Disclosure)

## Overview

This phase exposes registered APIs to language models: the `$ref` schema resolver, description builders, and the four discovery tools (`gateway_list_apis`, `gateway_describe_api`, `gateway_list_api_operations`, `gateway_describe_api_operation`) registered through `vscode.lm.registerTool` and re-registered whenever the registry changes. After this phase an agent can walk list_apis → describe_api → list_operations → describe_operation with zero network calls (NFR-4) and receive self-contained schemas (R-SCH-1/2).

> **As-built refinements (2026-08-24):**
> - Tool descriptions and input schemas are declared statically in package.json under `contributes.languageModelTools` — the Language Model Tools API requires model-facing metadata to be contributed, not passed at runtime. `src/vscode/tools.ts` registers only implementations, through a single `vscode.lm.registerTool` call site driven by a name/factory table whose factory functions return `LanguageModelTool` objects.
> - Schemas resolve against the model's `SchemaRegistry` (see the Phase 1 refinement of 2026-08-24); `resolveSchemaClosures(schemas, rootRefs)` takes the registry directly and never sees an `OpenApiDocument`.
> - `buildDescribeOperation(api, index, operationId)` consumes the prebuilt index from `registry.getEntry(apiId)` (derived once per mutation) instead of rebuilding it per invoke.
> - The `DISCOVERY_TOOL_NAMES` constant lives in `src/test/discovery.test.ts`; production code keys off the factory table instead.

## Task Details

### 1. Implement the schema resolver

- **Prerequisites / Dependencies:** Phase 1 types.
- **Affected Files:**
  - [schema-resolver.ts](../../src/core/schema-resolver.ts) (new)
- **Affected Symbols:** `resolveSchemaClosure(doc: OpenApiDocument, rootRef: string): ResolvedSchema[]`
- **Description:** Given a starting `$ref`, collect the transitive closure of `components.schemas` references (local refs only: `#/components/schemas/...`). Return each referenced schema flattened in encounter order so tool output can list them "after each other" per R-SCH-1. Cycle-safe via visited set. Unrelated components are never included.
- **Acceptance Criteria:**
  - [ ] A request-body ref plus its nested property refs all appear; sibling unrelated schemas do not.
  - [ ] Self-referencing and mutual-recursion schemas terminate.
  - [ ] Unknown/unresolvable ref produces a descriptive error naming the missing component.

### 2. Implement description builders

- **Prerequisites / Dependencies:** Tasks 1, Phase 1 Task 4.
- **Affected Files:**
  - [describe.ts](../../src/core/describe.ts) (new)
- **Affected Symbols:** `buildListApis(registrations)`, `buildDescribeApi(api)`, `buildListOperations(api, groups: string[])`, `buildDescribeOperation(api, operationId)`
- **Description:** Pure functions returning JSON-serializable objects for LLM consumption, reading from the nested `ApiModel` (see phase 1 refinement):
  - `list_apis`: `{ apiId, title, version, description? }[]`.
  - `describe_api`: metadata + `{ name, description?, operationCount }[]` groups straight from `model.groups` (R-DISC-2).
  - `list_operations`: uses `operationsInGroups(model, groups)` → operations of known groups; unknown names yield an error object listing available group names from the model (spec §4).
  - `describe_operation`: resolves via the API's operation index; parameter definitions from path/query/header params, request-body content schemas resolved via Task 1, response schemas keyed by status code — fully self-contained (R-SCH-2). Unknown `operationId` errors with valid IDs of the same API where feasible.
- **Acceptance Criteria:**
  - [ ] Each builder output is plain JSON (survives `JSON.stringify(JSON.parse(...))` round-trip).
  - [ ] `describe_operation` contains no reference to `components.schemas` outside its own closure.
  - [ ] Unknown group/operationId results enumerate valid alternatives.

### 3. Register discovery tools

- **Prerequisites / Dependencies:** Task 2, Phase 2 activation wiring.
- **Affected Files:**
  - [tools.ts](../../src/vscode/tools.ts) (new)
- **Affected Symbols:** `registerGatewayTools(context, registry): { refresh() }`
- **Description:** Register the four tools via `vscode.lm.registerTool` with JSON-schema `inputSchema`s matching spec §4 (`apiId` required everywhere; `groups: string[]` minItems 1 for `list_operations`). Each `invoke` reads purely from registry snapshots, returns `LanguageModelToolResult` with a single text part containing formatted JSON. Tool descriptions written for model consumption (NFR-3), e.g. `gateway_list_apis`: "Lists REST APIs registered by the user… start here before calling any API." Keep a module-level disposal list so `refresh()` unregisters + re-registers after registry mutations (wired to `onChange()` from Phase 2 Task 4).
- **Acceptance Criteria:**
  - [ ] After registering one API, `vscode.lm.tools` includes all four `gateway_*` names (integration check).
  - [ ] After unregistering, tools return the "no APIs registered" error result rather than throwing.
  - [ ] No network I/O occurs during any discovery invoke (all data from snapshot).

### 4. Integration-test the discovery flow

- **Prerequisites / Dependencies:** Tasks 1–3.
- **Affected Files:**
  - [discovery.test.ts](../../src/test/discovery.test.ts) (new)
- **Description:** Activate extension in test host, register fixture API programmatically through `ApiRegistry` + `registerGatewayTools`, then drive the full chain using `vscode.lm.invokeTool(name, { input, toolInvocationToken: undefined }, token)` (no confirmation needed for read-only discovery tools since they declare none). Assert: chain order works; `describe_operation` closure correctness on a fixture with nested refs; unknown-group error lists available groups.
- **Acceptance Criteria:**
  - [ ] End-to-end progressive disclosure chain succeeds against `petstore30.json` fixture.
  - [ ] Schema-closure assertion catches accidental over-inclusion (fixture contains a decoy schema not reachable from the tested operation).
  - [ ] Suite passes via `npm test`.

## Verification Plan

1. `npm run compile && npm test` — clean.
2. F5 → register petstore → open Copilot Chat agent mode → ask "what APIs can you call?" — verify the model uses `gateway_list_apis` and answers with the registered title.
3. Ask it to find an operation to fetch a pet by ID — verify it walks describe_api → list_operations → describe_operation without flooding context.
