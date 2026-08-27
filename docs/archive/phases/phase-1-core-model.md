---
type: guide
title: "Phase 1 — Core Model: Types, Parsing, ID Derivation, Grouping"
description: "Archived v0 phase building the pure-logic foundation: domain types, JSON-only OpenAPI 3.0.x/3.1.x parsing and validation, deterministic operation-ID derivation, and first-tag grouping, all unit-tested without importing vscode."
tags:
  - "implementation-plan"
  - "phase"
  - "core-model"
  - "openapi"
timestamp: "2026-08-27T00:00:00Z"
related:
  - "[Implementation Plan](../implementation-plan.md)"
  - "[Software Specification](../../specs/software-specification.md)"
---

# Phase 1 — Core Model: Types, Parsing, ID Derivation, Grouping

## Overview

This phase builds the pure-logic foundation every later phase consumes: the domain types, OpenAPI JSON parsing/validation, deterministic operation-ID derivation (R-ID-1..4), and a nested, grouped API model (R-GRP-1). No `vscode` imports here, so all of it is unit-testable immediately. Later phases wrap this core with VS Code adapters.

> **Refinement (agreed 2026-08-23):** instead of a flat operation list plus separate group summaries, `ApiSnapshot` holds a nested `ApiModel` — groups carry their operations (`OperationGroupModel { name, description?, operations[] }`), with tag descriptions propagated from `document.tags`. An in-memory `Map<operationId, OperationInfo>` index is derived from the model at load/refresh time via `buildOperationIndex`; it is never persisted, keeping one source of truth. The registry keeps one index per `apiId` because IDs are unique within an API only.
>
> **Refinement (agreed 2026-08-24):** `ApiModel` is fully self-contained so consumers never couple to the spec language: it carries `info { title, version, description? }` copied from `document.info` and `schemas: SchemaRegistry` — a JSON-serializable `Record<string, JsonSchema>` extracted once by `schemaRegistryFromDocument` in `openapi.ts`, the single point where OpenAPI specifics enter the model. Description builders and tools navigate only the model; the raw document remains in the snapshot purely as the last-good parse backing refresh. `buildApiModel(document)` derives everything internally (supersedes the two-argument shape listed in Task 4).

## Task Details

### 1. Define core domain types

- **Prerequisites / Dependencies:** None.
- **Affected Files:**
  - [types.ts](../../../src/core/types.ts) (new)
- **Affected Symbols:** `OpenApiDocument`, `ApiOperation`, `ApiRegistration`, `OperationInfo`, `OperationGroupModel`, `ApiModel`, `OperationParameter`
- **Description:** Model only what the tools need from an OpenAPI document: info block, servers, path-item operations (`operationId`, tags, method, path, parameters, requestBody, responses), and `components.schemas` for `$ref` lookup. `ApiRegistration` is the persisted record: `{ apiId, title, version, description?, baseUrl, specSource: { kind: 'url', url } | { kind: 'file', fsPath }, snapshot: ParsedApi }`. Keep everything JSON-typed (`unknown`-safe accessors where the spec allows arbitrary values).
- **Acceptance Criteria:**
  - [ ] `npm run check-types` passes with the new module referenced by no one (standalone).
  - [ ] No import of `vscode` anywhere under `src/core/`.

### 2. Implement OpenAPI JSON parsing and validation

- **Prerequisites / Dependencies:** Task 1.
- **Affected Files:**
  - [openapi.ts](../../../src/core/openapi.ts) (new)
- **Affected Symbols:** `parseSpec(jsonText: string): OpenApiDocument`, `SpecError`
- **Description:** Parse with `JSON.parse`; throw `SpecError` with actionable messages for: malformed JSON, YAML-looking input (heuristic: leading `key:` without `{` → "JSON only" message per R-REG-4), missing/non-string or non-conforming `openapi` field (accept `/^3\.0\.\d+$/` and `/^3\.1\.\d+$/` only), missing `info.title`, missing both `servers[].url` and workspace-provided base URL fallback. Export a helper `isSupportedVersion(version: string): boolean`.
- **Acceptance Criteria:**
  - [ ] Valid 3.0.3 and 3.1.0 documents parse successfully.
  - [ ] Swagger 2.0 (`swagger: "2.0"`), YAML text, and truncated JSON each reject with distinct, actionable error strings naming what to fix.

### 3. Unit-test spec parsing

- **Prerequisites / Dependencies:** Task 2.
- **Affected Files:**
  - [openapi.test.ts](../../../src/test/core/openapi.test.ts) (new)
- **Description:** Mocha suites (no `vscode` import; picked up by `.vscode-test.mjs` glob `out/test/**/*.test.js`). Cover: accepted 3.0.x/3.1.x samples, rejected 2.0, rejected YAML, rejected malformed JSON, rejected unsupported future version `4.0.0`.
- **Acceptance Criteria:**
  - [ ] All cases assert on thrown error messages containing actionable guidance.
  - [ ] Suite passes via `npm test`.

### 4. Derive operation IDs and build groups

- **Prerequisites / Dependencies:** Tasks 1–2.
- **Affected Files:**
  - [operations.ts](../../../src/core/operations.ts) (new)
- **Affected Symbols:** `deriveOperationId(tag: string, method: string, path: string): string`, `buildOperations(doc: OpenApiDocument): OperationInfo[]`, `buildApiModel(document, operations): ApiModel`, `buildOperationIndex(model): Map<string, OperationInfo>`, `operationsInGroups(model, names): { found, unknown }`
- **Description:** For every path × method (`get|put|post|delete|options|head|patch|trace`) produce an `OperationInfo`. Use declared `operationId` verbatim (R-ID-1); otherwise kebab-case `<tag>/<method>-<path>` per R-ID-2: skip `{var}` segments, split on `/` and `_`, join with `-`. `buildApiModel` nests operations into alphabetically sorted groups (first tag, else `default`; R-GRP-1) and propagates tag descriptions from `document.tags`. Enforce uniqueness within the API by appending `-2`, `-3`, … on collision (R-ID-3). Pure functions only so output is deterministic across runs (R-ID-4).
- **Acceptance Criteria:**
  - [ ] First-tag `pets`, `GET /pets/{petId}` without `operationId` → `pets-get-pets`.
  - [ ] Two operations deriving `get-pet` yield `get-pet`, `get-pet-2`.
  - [ ] Untagged operation lands in group `default`.
  - [ ] Same document always yields identical ID set across repeated calls.

### 5. Unit-test derivation and grouping

- **Prerequisites / Dependencies:** Task 4.
- **Affected Files:**
  - [operations.test.ts](../../../src/test/core/operations.test.ts) (new)
- **Description:** Table-driven tests over the acceptance rules above plus: explicit `operationId` passthrough, mixed separators (`/a_b/c/{id}`), collision suffix ordering, determinism loop (100 iterations, deep-equal snapshot), tag-description propagation, index/model equivalence, and `operationsInGroups` unknown-name reporting.
- **Acceptance Criteria:**
  - [ ] Every R-ID-* and R-GRP-1 rule has at least one failing-first test that now passes.
  - [ ] `npm test` green.

## Verification Plan

1. `npm run compile-tests && npm run lint && npm run check-types` — clean.
2. `npm test` — new suites pass; existing scaffold suite unaffected.
3. Grep guard: no `from 'vscode'` matches under `src/core/`.
