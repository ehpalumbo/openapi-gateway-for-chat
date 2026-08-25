# Phase 5 — Response Handling & Polish

> **Revision (2026-08-26, code review):** the spill design below was removed
> before release. `vscode.workspace.fs` cannot stream writes, and buffering
> whole bodies to spill them would defeat the memory-safety goal; per review
> decision the extension does **not** write response bodies to files at all.
> Final behavior (see spec §3.8): every response carrying an HTTP status is
> returned as two `LanguageModelDataPart`s — JSON metadata
> (`{status, statusLine, headers}`) then the exact raw body bytes with their
> MIME type. Binaries inline like text; non-2xx bodies are served whole with
> no cap; only network failures (no status) use text error results. The
> `openapiGateway.inlineResponseThreshold` setting was dropped. Tasks 1–4
> below are superseded; Task 5's polish pass was completed against the final
> design.
>
> **Revision 2 (2026-08-26, post-review bug report):** Copilot Chat silently
> drops non-image data parts from tool results (microsoft/vscode#275300), so
> revision 1's data parts never reached the model. Current shape (spec §3.8):
> text-part metadata + UTF-8 body for textual types, image data parts for
> vision-safe images, spill files under `<storageUri>/response-spills/`
> (class-based `WorkspaceSpillStore`, `workspace.fs`, deactivation cleanup)
> only for non-image binaries.

## Overview

This phase finishes R-RESP-1..3 by replacing the Phase 4 pass-through response processor with size-aware handling (inline below threshold via `vscode.LanguageModelDataPart`, temp-file spill above, binaries always to file), wires the `openapiGateway.inlineResponseThreshold` setting, and does a final error-message/README/E2E polish pass. This is the release-readiness phase.

## Task Details

### 1. Implement the response handler

- **Prerequisites / Dependencies:** Phase 1 types.
- **Affected Files:**
  - [response-handler.ts](../../src/core/response-handler.ts) (new)
- **Affected Symbols:** `processResponse(raw: RawResponse, opts: { thresholdBytes: number; writer: SpillWriter }): ProcessedResponse`, `RawResponse`, `ProcessedResponse`
- **Description:** Pure-ish function taking buffered body bytes + content type. Binary detection via non-text content types (`application/json` and `text/*` are text; everything else — images, octet-stream, pdf… — is binary) (R-RESP-3). If byte length ≤ threshold → `{ kind: 'inline', mimeType, bytes }`; the tools layer serves this as a `vscode.LanguageModelDataPart` carrying the raw response bytes with their MIME type (R-RESP-1). Otherwise → write bytes via the injected `SpillWriter` seam — whose production implementation uses **`vscode.workspace.fs.writeFile`** — to a **uniquely named** file (UUID-suffixed, e.g. `<apiId>-<operationId>-<uuid>.json`) so concurrent/repeated calls never override each other; extension is derived from the MIME type (`.json` for JSON so tools like `jq` work) and return `{ kind: 'file', filePath, statusLine, headers, byteSize }` (R-RESP-2). Every spilled path is recorded so deactivation cleanup can remove it.
- **Acceptance Criteria:**
  - [ ] Body at exactly the threshold inlines (bytes + mimeType); threshold+1 spills.
  - [ ] Binary content type always spills regardless of size.
  - [ ] Spilled result includes byte size and status line.
  - [ ] Two consecutive spills produce distinct file names.
  - [ ] The inline payload exposes the exact raw bytes and the response's MIME type.

### 2. Unit-test response splitting

- **Prerequisites / Dependencies:** Task 1.
- **Affected Files:**
  - [response-handler.test.ts](../../src/test/core/response-handler.test.ts) (new)
- **Description:** Boundary tests (threshold ±1), binary detection table (`image/png`, `application/octet-stream`, `text/plain`, `application/json`), writer-callback assertions capturing unique paths/mode/bytes without touching the filesystem; inline assertions check exact bytes and MIME type exposure.
- **Acceptance Criteria:**
  - [ ] All Task 1 criteria asserted; no real temp files created during tests.

### 3. Wire into invocation + settings

- **Prerequisites / Dependencies:** Tasks 1, Phase 4 Task 3, Phase 2 Task 6 setting.
- **Affected Files:**
  - [tools.ts](../../src/vscode/tools.ts) (modify), [extension.ts](../../src/extension.ts) (modify)
- **Description:** Replace inline-only processing with `processResponse`, reading `thresholdBytes` from `workspace.getConfiguration('openapiGateway')` per call. Inline results are served as `new vscode.LanguageModelDataPart(bytes, mimeType)` plus a text part with the status line and headers. For spilled results, render a **text-part** tool output with the absolute file path plus metadata (status line, headers, byteSize) and a hint suggesting shell tools (`jq`, `grep`) or opening the file — model-actionable wording (NFR-3). The production spill writer uses `vscode.workspace.fs`: ensure `<globalStorage>/response-spills/` via `workspace.fs.createDirectory`, write with `workspace.fs.writeFile` under UUID-suffixed names, and track created paths. On `deactivate`, best-effort delete all recorded spill files via `workspace.fs.delete`.
- **Acceptance Criteria:**
  - [ ] Invoking an endpoint returning > 8 KB yields a text result containing a file path, not the body.
  - [ ] Invoking an endpoint returning ≤ 8 KB yields a result containing a `LanguageModelDataPart` with the exact body bytes and MIME type.
  - [ ] Lowering the setting to e.g. 100 flips previously-inlined responses to file mode without re-registration.
  - [ ] After `deactivate`, no spill files remain in the spill directory.

### 4. Integration-test large/binary responses

- **Prerequisites / Dependencies:** Task 3.
- **Affected Files:**
  - [invocation.test.ts](../../src/test/invocation.test.ts) (modify)
- **Description:** Extend the local server fixtures with routes returning ~20 KB JSON, a small PNG, and a small JSON payload. Assert file-mode result shape for both spill cases (oversize JSON and the PNG — binaries always spill regardless of size), with the spilled file existing on disk at a unique path (real globalStorage tmpdir acceptable here). Assert the small-JSON case yields a `LanguageModelDataPart` carrying the exact bytes and `application/json` MIME type.
- **Acceptance Criteria:**
  - [ ] Both spill cases produce `kind: 'file'` results whose paths exist, are unique across repeated calls, and match expected byte sizes.
  - [ ] The inline case produces a `LanguageModelDataPart` with matching bytes and MIME type.

### 5. Polish pass: errors, README, final verification

- **Prerequisites / Dependencies:** All prior tasks/phases.
- **Affected Files:**
  - [README.md](../../README.md) (modify), all `src/**` files as needed
- **Description:** Sweep all user/model-facing strings against NFR-3 (specific, actionable, secret-free); verify every command has a sensible title/category ("OpenAPI Gateway"); update README with install/dev/test instructions, registration walkthrough, response-serving behavior (inline `LanguageModelDataPart` payloads vs. spill-file text results), spill-file storage/cleanup on deactivation, security notes (SecretStorage, redaction), and limitations (JSON-only specs, Bearer-only auth). Run full DoD checklist from the index plan.
- **Acceptance Criteria:**
  - [ ] No error message leaks token values or full spec URLs containing credentials.
  - [ ] README documents all five commands and five tools, plus the inline/spill response behavior and cleanup guarantee.
  - [ ] `npm run compile && npm test` green; whole-feature manual checklist executed once.

## Verification Plan

1. `npm run compile && npm test` — clean across all suites.
2. Manual: point an API at an endpoint returning a > 8 KB payload → confirm chat shows a text result with the file reference; open it; run `jq` over it as suggested by the hint.
3. Manual: point an API at an endpoint returning ≤ 8 KB → confirm the tool result carries the raw bytes as a data part with the correct MIME type.
4. Manual: set threshold to `100`, retry → behavior flips without reloading.
5. Manual: reload/dispose the window → verify `<globalStorage>/response-spills/` is emptied on deactivation.
6. Full manual checklist from the index plan's Whole-Feature Verification section.
