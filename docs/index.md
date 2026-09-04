# Repository Docs

> Cross-cutting knowledge base index. Read individual pages for full context.

## Specifications

High-level project specifications defining goals, scope, functional and non-functional requirements for the extension.

- [Software Specification](specs/software-specification.md) - Initial requirement set covering API registration (OpenAPI 3.0/3.1), Bearer-token auth, operation ID derivation rules, tag-based grouping, the four progressive-disclosure discovery tools plus invocation tool with inline or file-backed (`bodyFile`) bodies, confirmation safety flow with size-only file previews, and size-aware response handling.

## Architecture

Layering decisions and structural migration plans behind the current `src/domain`, `src/application`, and `src/infrastructure` layout.

- [Onion Architecture Migration Plan](onion-architecture-plan.md) - Architecture design and plan migrating the extension to Domain, Application (Use Cases & Ports), and Infrastructure layers.

## Archive

Historical v0 implementation planning documents, archived once the first shippable release landed; retained for design ancestry and build-out context behind the current specification.

- [Implementation Plan](archive/implementation-plan.md) - Phased MVP build-out record: two-layer core/store/vscode architecture, the five-tool surface, test strategy, and whole-feature Definition of Done.

## Implementation Phases

Per-phase build-out records behind the archived implementation plan; `src/` paths cited here predate the onion-architecture migration (`src/core` → `src/domain`, `src/store` + `src/vscode` → `src/infrastructure`).

- [Phase 1 — Core Model](archive/phases/phase-1-core-model.md) - Core domain types, JSON-only OpenAPI 3.0.x/3.1.x parsing and validation, deterministic operation-ID derivation, and first-tag grouping, all unit-testable without importing `vscode`.
- [Phase 2 — Registration & Persistence](archive/phases/phase-2-registration.md) - Size-limited fetching, the globalState registry with last-good snapshots, SecretStorage token store, the four commands, and activation refresh.
- [Phase 3 — Discovery Tools](archive/phases/phase-3-discovery-tools.md) - `$ref` schema-closure resolution, description builders, and the four `gateway_*` discovery tools registered via `vscode.lm` with network-free discovery.
- [Phase 4 — Invocation & Safety](archive/phases/phase-4-invocation-safety.md) - Request builder, `gateway_invoke_operation` against the registered base URL, native `prepareInvocation` confirmation, and structured model-readable errors.
- [Phase 5 — Response Handling & Polish](archive/phases/phase-5-response-handling-polish.md) - R-RESP response routing with inline/spill mechanics and deactivation cleanup, plus the final error-message, README, and end-to-end release pass.
