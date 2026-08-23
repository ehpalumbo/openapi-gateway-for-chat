# Implementation Plan: OpenAPI Gateway for Chat — MVP

## Metadata

- **Author:** ox-alpha
- **Date:** 2026-08-23
- **Phased Implementation:** Yes

### References

- [Software Specification](../specs/software-specification.md)

---

## Executive Summary & Architecture

Implement the MVP of a VS Code extension that exposes remote REST APIs to AI agents as native language model tools via `vscode.lm.registerTool`. Users register OpenAPI **3.0.x / 3.1.x JSON** documents by URL or workspace file picker; registrations persist user-globally (`globalState`) with Bearer tokens in `SecretStorage`. Five tools (`gateway_list_apis`, `gateway_describe_api`, `gateway_list_operations`, `gateway_describe_operation`, `gateway_invoke_operation`) provide progressive discovery and invocation. Non-safe invocations are confirmed through the platform's native `prepareInvocation` / `confirmationMessages` flow (grants deferred post-MVP). Responses are size-aware: below 8 KB (configurable) they are inlined; above they spill to a temp file; binaries always spill.

Architecture: two strict layers.

```
src/
├── core/                   # Pure logic — never imports 'vscode' (NFR-6)
│   ├── types.ts            # ParsedApi, ApiRegistration, OperationInfo, OperationGroup
│   ├── openapi.ts          # parseSpec / validateDocument (JSON-only, 3.0.x|3.1.x)
│   ├── operations.ts       # operationId derivation (R-ID-*), first-tag grouping (R-GRP-*)
│   ├── schema-resolver.ts  # $ref closure → self-contained describe_operation (R-SCH-*)
│   ├── request-builder.ts  # URL construction, required-path-param enforcement (R-INV-*)
│   └── response-handler.ts # threshold split, temp-file spill, binary detection (R-RESP-*)
├── store/
│   ├── registry.ts         # ApiRegistry over globalState; last-good snapshots (R-REG-5..7)
│   └── secrets.ts          # TokenStore over SecretStorage (R-AUTH-2)
├── vscode/                 # Thin VS Code adapters
│   ├── http.ts             # fetchWithLimit — size-limited fetching (NFR-2)
│   ├── commands/           # one module per command; index wires IDs
│   │   ├── common.ts       # CommandContext, spec loading/parsing, suggestion helpers (R-REG-*)
│   │   ├── register.ts     # register-from-url / register-from-file handlers (R-REG-1..2, 8, 9)
│   │   ├── unregister.ts   # unregister handler (R-REG-3)
│   │   ├── refresh.ts      # refresh logic shared with activation (R-REG-6, 7)
│   │   └── index.ts        # binds handlers to vscode.commands IDs (R-REG-1..3, 6)
│   └── tools.ts            # vscode.lm.registerTool wiring + prepareInvocation safety (R-SAFE-*)
└── extension.ts            # Activation: refresh specs, (re)register tools + commands
```

Key decisions baked into this design (resolved in the spec):

- Tools re-register whenever the registry changes so discovery is purely in-memory (NFR-4).
- Confirmation uses the host UI (Continue / Cancel); no custom modal, no grant store in MVP.
- All tests run through `@vscode/test-cli` (glob `out/test/**/*.test.js`); core unit tests simply do not import `vscode`.

---

## Phase Index

- **Phase 1 — Core model:** types, OpenAPI JSON parsing/validation, operation-ID derivation, tag grouping, plus unit tests. → [phases/phase-1-core-model.md](phases/phase-1-core-model.md)
- **Phase 2 — Registration & persistence:** fetch wrapper, registry/secrets stores, four commands, activation refresh, package.json contributions. → [phases/phase-2-registration.md](phases/phase-2-registration.md)
- **Phase 3 — Discovery tools:** schema resolver, description builders, four `gateway_*` discovery tools wired to `vscode.lm`. → [phases/phase-3-discovery-tools.md](phases/phase-3-discovery-tools.md)
- **Phase 4 — Invocation & safety:** request builder, `gateway_invoke_operation`, native confirmation via `prepareInvocation`, structured errors. → [phases/phase-4-invocation-safety.md](phases/phase-4-invocation-safety.md)
- **Phase 5 — Response handling & polish:** size-aware responses, binary detection, settings, error-message pass, end-to-end verification. → [phases/phase-5-response-handling-polish.md](phases/phase-5-response-handling-polish.md)

---

## Configuration & Environment Updates

- **Environment Variables:** None.
- **Feature Flags:** None.
- **External Dependencies:** None beyond the existing scaffold (`@types/vscode`, `@vscode/test-cli`, esbuild). No runtime dependencies — use Node's global `fetch` (Node ≥ 18 in VS Code runtime).
- **Settings contributed:** `openapiGateway.inlineResponseThreshold` (number, bytes, default `8192`).

---

## Whole-Feature Verification Plan

### Automated Tests

All suites run via `npm test` (`vscode-test`), compiled by `npm run compile-tests`:

- Unit suites under `src/test/core/**` exercise pure logic (parsing, ID derivation, schema resolution, request building, response splitting) without importing `vscode`.
- Integration suites under `src/test/**` cover registration flows against fixtures in `src/test/fixtures/`, tool visibility via `vscode.lm.tools`, and live invocation against an ephemeral local HTTP server started inside the test.

### Manual Verification Steps

1. F5 launch (Extension Development Host); run **Register API from URL** against a public petstore-style 3.0 JSON spec; confirm prompts for `apiId`, server selection, optional token.
2. Reload window; confirm the API survives reload and tools are visible in Copilot Chat agent mode.
3. In Copilot Chat agent mode, ask the agent to discover and call a safe endpoint; then a `POST`; confirm the inline Continue/Cancel confirmation appears with redacted headers.
4. Invoke an endpoint returning > 8 KB; confirm the tool result references a temp file instead of inlining.

### Definition of Done

- [ ] `npm run compile` passes clean (types + lint + build)
- [ ] `npm test` passes all unit and integration suites
- [ ] All spec requirements R-REG-*, R-AUTH-*, R-ID-*, R-GRP-*, R-DISC-*, R-SCH-*, R-INV-*, R-SAFE-1..3, R-RESP-* verified
- [ ] README updated with usage instructions
