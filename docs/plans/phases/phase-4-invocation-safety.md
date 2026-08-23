# Phase 4 — Invocation Tool & Safety Confirmation

## Overview

This phase completes the agent-facing surface: `gateway_invoke_operation` executes operations against the registered base URL only (R-INV-2..4), with structured, model-readable error results (R-INV-5) and Bearer-token injection from `SecretStorage` (R-AUTH-1..3). Safety uses the platform's native confirmation: `prepareInvocation` returns rich `confirmationMessages` for non-safe methods and none for safe ones (R-SAFE-1..3). Grants are explicitly deferred (spec Non-Goals).

## Task Details

### 1. Implement the request builder

- **Prerequisites / Dependencies:** Phase 1 types.
- **Affected Files:**
  - [request-builder.ts](../../src/core/request-builder.ts) (new)
- **Affected Symbols:** `buildRequest(reg: ApiRegistration, op: OperationInfo, input: InvokeInput): { method, url, headers, body? }`, `InvokeInput`
- **Description:** Substitute path params into the path template; fail fast listing missing required path params with actionable message (R-INV-3). Serialize query params supporting string/number/boolean/array values (arrays → repeated keys). Merge user headers under spec-declared header params. Base URL is strictly `reg.baseUrl`; reject any URL-ish input fields (R-INV-4). Body passes through as JSON when the operation declares a request body.
- **Acceptance Criteria:**
  - [ ] Missing required path param → error enumerating exactly which params are required by name.
  - [ ] `GET /pets/{petId}` with `petId=42` against base `https://api.example.com/v1` yields `https://api.example.com/v1/pets/42`.
  - [ ] Array query param renders as repeated keys; booleans as lowercase `true`/`false`.

### 2. Unit-test the request builder

- **Prerequisites / Dependencies:** Task 1.
- **Affected Files:**
  - [request-builder.test.ts](../../src/test/core/request-builder.test.ts) (new)
- **Description:** Cover all acceptance rules plus trailing-slash normalization between base URL and path template, and rejection when input attempts to override the host via header injection of `Host`.
- **Acceptance Criteria:**
  - [ ] All criteria from Task 1 have corresponding assertions; suite green in same phase.

### 3. Implement invoke tool with native confirmation

- **Prerequisites / Dependencies:** Tasks 1, Phase 3 tools infrastructure, Phase 2 stores.
- **Affected Files:**
  - [tools.ts](../../src/vscode/tools.ts) (modify)
- **Affected Symbols:** `registerGatewayTools(...)` gains `gateway_invoke_operation`; new helpers `isSafeMethod(method)`, `buildConfirmationMessage(request)`
- **Description:** Register fifth tool:
  - `prepareInvocation`: resolve operation from registry; if method is not `GET`/`HEAD`, return `confirmationMessages` whose MarkdownString shows HTTP method, resolved URL, headers with `Authorization` redacted to `Bearer ***`, and a truncated body preview (R-SAFE-3); otherwise omit confirmation entirely (R-SAFE-1).
  - `invoke`: build request (Task 1), attach `Authorization: Bearer <token>` from `TokenStore` if present (never logged or echoed — NFR-1), execute with global `fetch` + AbortSignal timeout, then hand the raw response to a pluggable response processor (Phase 5; this phase returns inline text for everything so Phase 5 is a drop-in).
  - Errors — network failure, non-2xx, builder validation — return structured result objects `{ error, method, url, status?, bodyExcerpt? }` instead of throwing, formatted for model retry reasoning (R-INV-5). Non-JSON response bodies are included as excerpted text.
- **Acceptance Criteria:**
  - [ ] `prepareInvocation` for POST returns confirmationMessages containing the resolved URL and redacted Authorization; GET returns none.
  - [ ] A 404 response produces an error result including status and body excerpt, not a thrown exception.
  - [ ] Token value appears nowhere in any returned result string.

### 4. Integration-test invocation end-to-end

- **Prerequisites / Dependencies:** Task 3.
- **Affected Files:**
  - [invocation.test.ts](../../src/test/invocation.test.ts) (new), [fixtures/echo30.json](../../src/test/fixtures/echo30.json) (new)
- **Description:** Ephemeral local HTTP server asserting received method/path/headers/body; fixture spec points its server at it. Cases: successful GET round-trip; required-path-param fast-fail message; POST flow asserting `prepareInvocation` output shape (called directly on the registered tool object obtained via `vscode.lm.tools`); auth header present when token set via `TokenStore`; structured error on server 500.
- **Acceptance Criteria:**
  - [ ] Local server receives exactly the request the builder specified (method, encoded path, query, body).
  - [ ] All Task 3 acceptance behaviors observable through public API surface (`vscode.lm`).

## Verification Plan

1. `npm run compile && npm test` — clean.
2. F5 → register an API with a token → in Copilot Chat agent mode ask the agent to create a resource → verify inline Continue/Cancel prompt shows method/URL/redacted headers; Cancel prevents execution; Continue performs it.
3. Ask for a nonexistent resource ID → verify the agent receives the structured 404 result and can reason about it in its reply.
