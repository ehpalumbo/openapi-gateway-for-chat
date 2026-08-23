# Phase 5 — Response Handling & Polish

## Overview

This phase finishes R-RESP-1..3 by replacing the Phase 4 pass-through response processor with size-aware handling (inline below threshold, temp-file spill above, binaries always to file), wires the `openapiGateway.inlineResponseThreshold` setting, and does a final error-message/README/E2E polish pass. This is the release-readiness phase.

## Task Details

### 1. Implement the response handler

- **Prerequisites / Dependencies:** Phase 1 types.
- **Affected Files:**
  - [response-handler.ts](../../src/core/response-handler.ts) (new)
- **Affected Symbols:** `processResponse(raw: RawResponse, opts: { thresholdBytes: number; tmpDir: string }): ProcessedResponse`, `RawResponse`, `ProcessedResponse`
- **Description:** Pure-ish function taking buffered body bytes + content type. Binary detection via non-text content types (`application/json` and `text/*` are text; everything else — images, octet-stream, pdf… — is binary) (R-RESP-3). If text and byte length ≤ threshold → `{ kind: 'inline', statusLine, headers, body }` (R-RESP-1). Otherwise → write bytes to a uniquely named file in `tmpDir` (`.json` extension for JSON so tools like `jq` work) and return `{ kind: 'file', filePath, statusLine, headers, byteSize }` (R-RESP-2). File writing is injected as a callback so unit tests need no disk.
- **Acceptance Criteria:**
  - [ ] Body at exactly the threshold inlines; threshold+1 spills.
  - [ ] Binary content type always spills regardless of size.
  - [ ] Spilled result includes byte size and status line.

### 2. Unit-test response splitting

- **Prerequisites / Dependencies:** Task 1.
- **Affected Files:**
  - [response-handler.test.ts](../../src/test/core/response-handler.test.ts) (new)
- **Description:** Boundary tests (threshold ±1), binary detection table (`image/png`, `application/octet-stream`, `text/plain`, `application/json`), writer-callback assertions capturing path/mode without touching the filesystem.
- **Acceptance Criteria:**
  - [ ] All Task 1 criteria asserted; no real temp files created during tests.

### 3. Wire into invocation + settings

- **Prerequisites / Dependencies:** Tasks 1, Phase 4 Task 3, Phase 2 Task 6 setting.
- **Affected Files:**
  - [tools.ts](../../src/vscode/tools.ts) (modify)
- **Description:** Replace inline-only processing with `processResponse`, reading `thresholdBytes` from `workspace.getConfiguration('openapiGateway')` per call. For spilled results, render tool output with the absolute file path plus metadata (status line, headers, byteSize) and a hint suggesting shell tools (`jq`, `grep`) or opening the file — model-actionable wording (NFR-3). Best-effort cleanup of spill files on `deactivate`.
- **Acceptance Criteria:**
  - [ ] Invoking an endpoint returning > 8 KB yields a result containing a file path, not the body.
  - [ ] Lowering the setting to e.g. 100 flips previously-inlined responses to file mode without re-registration.

### 4. Integration-test large/binary responses

- **Prerequisites / Dependencies:** Task 3.
- **Affected Files:**
  - [invocation.test.ts](../../src/test/invocation.test.ts) (modify)
- **Description:** Extend the local server fixtures with routes returning ~20 KB JSON and a small PNG. Assert file-mode result shape for both, inline mode under threshold, and that the spilled file exists on disk in tests (real tmpdir acceptable here).
- **Acceptance Criteria:**
  - [ ] Both oversize cases produce `kind: 'file'` results whose paths exist and match expected byte sizes.

### 5. Polish pass: errors, README, final verification

- **Prerequisites / Dependencies:** All prior tasks/phases.
- **Affected Files:**
  - [README.md](../../README.md) (modify), all `src/**` files as needed
- **Description:** Sweep all user/model-facing strings against NFR-3 (specific, actionable, secret-free); verify every command has a sensible title/category ("OpenAPI Gateway"); update README with install/dev/test instructions, registration walkthrough, security notes (SecretStorage, redaction), and limitations (JSON-only specs, Bearer-only auth). Run full DoD checklist from the index plan.
- **Acceptance Criteria:**
  - [ ] No error message leaks token values or full spec URLs containing credentials.
  - [ ] README documents all five commands and five tools.
  - [ ] `npm run compile && npm test` green; whole-feature manual checklist executed once.

## Verification Plan

1. `npm run compile && npm test` — clean across all suites.
2. Manual: point an API at an endpoint returning a > 8 KB payload → confirm chat shows file reference; open it; run `jq` over it as suggested by the hint.
3. Manual: set threshold to `100`, retry → behavior flips without reloading.
4. Full manual checklist from the index plan's Whole-Feature Verification section.
