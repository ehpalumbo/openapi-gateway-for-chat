---
type: specification
title: "OpenAPI Gateway for Chat — Software Specification"
description: "Initial requirement set for the VS Code extension that exposes registered OpenAPI-described REST APIs as native language model tools for Copilot Chat agents."
tags:
  - "specification"
  - "vscode-extension"
  - "language-model-tools"
  - "openapi"
timestamp: "2026-08-23T00:00:00Z"
related:
  - "[Repository Docs](../index.md)"
resource:
  - "package.json"
  - "src/extension.ts"
---

# Software Specification: OpenAPI Gateway for Chat

## 1. Overview

This extension exposes remote REST APIs to AI agents inside VS Code as **native language model tools** via the Language Model Tools API (`vscode.lm.registerTool`). Users register APIs by providing **OpenAPI v3.0 / v3.1 specifications** through extension commands. Once registered, any language model consumer (Copilot Chat agent mode, other chat participants, other extensions) can discover and invoke those APIs.

The same use case is achievable today with MCP servers derived from OpenAPI specs, which VS Code supports natively. This extension exists because:

- Deriving, hosting, and running MCP servers per API may be considered an operational burden.
- Some users working in enterprise environments lack permission to enable/use MCP servers in VS Code.

The extension is therefore a **convenience layer**: no external processes, no extra infrastructure — registration happens entirely inside the editor.

## 2. Goals and Non-Goals

### Goals (MVP)

- Register/unregister APIs from OpenAPI 3.0.x and 3.1 documents.
- Register language model tools for progressive API discovery and invocation.
- Static Bearer-token authentication.
- Safe-by-default invocation of non-idempotent operations via the platform's native tool-confirmation flow.
- Size-aware response handling so large payloads do not flood model context.

### Non-Goals (explicitly out of MVP scope)

- **"Always allow this operation" grants and their revocation** (originally R-SAFE-4): deferred post-MVP. Every non-safe invocation requires user confirmation in the chat UI; no approval persistence is implemented in this release.
- Management UI beyond commands (no dedicated views, diagnostics panels, or request-history log).
- OAuth2/OIDC or any auth scheme other than static Bearer tokens.
- Swagger 2.0 support.
- Telemetry and marketplace publishing preparation.
- Per-workspace scoping of registrations.

## 3. Functional Requirements

### 3.1 API Registration

| ID | Requirement |
| ---- | ------------- |
| R-REG-1 | The extension contributes a command to register an API from an `http`/`https` URL pointing to an OpenAPI document. |
| R-REG-2 | The extension contributes a command to register an API from an OpenAPI document in the current workspace (file picker). |
| R-REG-3 | The extension contributes a command to unregister a previously registered API. |
| R-REG-4 | Supported specification versions: OpenAPI **3.0.x** and **3.1.x**, in **JSON format only** (YAML documents are rejected with a clear, actionable error message). Other versions are rejected likewise. |
| R-REG-5 | Registrations persist at **user-global scope** (`globalState`) and survive window reloads; they apply to all workspaces. |
| R-REG-6 | Remote specs are re-fetched on extension activation and via a manual "refresh" command. Local-file specs are re-read from disk on activation/refresh. |
| R-REG-7 | If a spec fails to parse or fetch at refresh time, existing registrations remain usable from the last good snapshot and the failure is surfaced to the user without blocking other registrations. |
| R-REG-8 | Registration requires a unique, user-visible API identifier (`apiId`); conflicts are rejected and resolved by prompting the user. |
| R-REG-9 | Registration requires a user-confirmed default server/base URL for the API; this will be used to invoke the API later. The extension always prompts the user to confirm or override the base URL at registration time, pre-filled from the spec's declared server(s); specs carrying placeholder URIs can thus be corrected without re-registration. |

### 3.2 Authentication

| ID | Requirement |
| ---- | ------------- |
| R-AUTH-1 | The only supported auth scheme in this release is a **static Bearer token** sent as the `Authorization: Bearer <token>` header. |
| R-AUTH-2 | Tokens are configured at registration time and stored exclusively in VS Code `SecretStorage`. They MUST NOT be persisted in settings, global state, logs, or tool results. |
| R-AUTH-3 | APIs registered without a token are invoked unauthenticated. |

### 3.3 Operation Identity

Every operation must have a resolvable operation ID used by all discovery and invocation tools.

| ID | Requirement |
| ---- | ------------- |
| R-ID-1 | If the spec declares `operationId`, it is used verbatim. |
| R-ID-2 | When the operation does not declare an `operationId`, the ID is derived as kebab-cased `<tag>/<method>-<path>` where: `<tag>` is the operation's group tag (see R-GRP-1); path-template variables (`{petId}`) are skipped; separators (`/`, `_`) become `-`. Example: first tag `pets`, `GET /pets/{petId}` → `pets-get-pets`. |
| R-ID-3 | Derived IDs are unique within the API. On collision, an incrementing suffix starting at `-2` is appended: `get-pet`, `get-pet-2`, `get-pet-3`. |
| R-ID-4 | ID derivation is deterministic across activations and refreshes (same spec → same IDs). |

### 3.4 Operation Groups

| ID | Requirement |
|----|-------------|
| R-GRP-1 | Operations are grouped by the **first tag** they declare. An operation with no tags belongs to the `default` group. |
| R-GRP-2 | Group membership is exposed to agents via `describe_api`; groups are the unit of listing in `list_operations`. |

### 3.5 Discovery Tools (Progressive Disclosure)

Discovery is staged so agents pull only what they need — some registered APIs may have hundreds of operations, and not all groups are relevant for a given task.

Flow: **`list_apis` → `describe_api` → `list_operations` → `describe_operation`**

| ID | Tool | Input | Returns |
| ---- | ------ | ------- | --------- |
| R-DISC-1 | `list_apis` | – | Registered APIs: `apiId`, title, short description/version. |
| R-DISC-2 | `describe_api` | `apiId` | API metadata plus its **operation groups**: group name, operation count, brief description when available — enabling the agent to select relevant groups. |
| R-DISC-3 | `list_operations` | `apiId`, one or more group names | Operations in the selected groups: operation ID, required parameters, description. |
| R-DISC-4 | `describe_operation` | `apiId`, `operationId` | Full operation input/output detail: parameter definitions derived from path variables / query parameters/ request headers, request-body schema, response schemas per status code. Only what is relevant for the agent to invoke the tool using `invoke_operation`. |

| ID | Requirement |
|----|-------------|
| R-SCH-1 | When describing an operation, **only the JSON schemas relevant to that operation** are returned: its parameters and its request/response body schemas; schema references are looked up and listed after each other in the tool response. Unrelated schema components MUST NOT be included. |
| R-SCH-2 | Schema output must be self-contained — an agent reading `describe_operation` needs no further lookups to construct a valid request body. |

### 3.6 Invocation Tool

| ID | Requirement |
| ---- | ------------- |
| R-INV-1 | A single tool `invoke_operation` executes an operation against a registered API. |
| R-INV-2 | Structured input schema: `{ apiId, operationId, pathParams?, queryParams?, headers?, body? }`. The agent fills values based on `describe_operation` output. |
| R-INV-3 | Path parameters marked required in the spec are enforced: invocation fails fast with an actionable message if they are missing. |
| R-INV-4 | Requests are built strictly from the spec's server/base URL; the tool does not accept arbitrary URLs. |
| R-INV-5 | Errors (network failures, non-2xx responses, validation errors) are returned as structured, descriptive tool results — formatted so the model can reason about retry or correction. |

### 3.7 Safety: Destructive Call Confirmation

Confirmation is implemented via the Language Model Tools API's native mechanism: `prepareInvocation` returning `confirmationMessages`. The host (Copilot Chat) renders the confirmation inline in the chat UI with its own **Continue** / **Cancel** buttons; the extension does not build custom modals. Note that the exact button set is controlled by the host and is not customizable.

| ID | Requirement |
| ---- | ------------- |
| R-SAFE-1 | Safe methods (`GET`, `HEAD`) execute without confirmation: `prepareInvocation` returns no `confirmationMessages` for `invoke_operation` calls resolving to safe methods. |
| R-SAFE-2 | Non-safe methods (`POST`, `PUT`, `PATCH`, `DELETE`, and any others) require user approval before each call: `prepareInvocation` returns `confirmationMessages` for such calls, causing the host to prompt before every invocation. |
| R-SAFE-3 | The confirmation message content is rich and model/user-readable: HTTP method, resolved URL, headers to be sent (with the Authorization header redacted), and a body preview. |

### 3.8 Response Handling

| ID | Requirement |
| ---- | ------------- |
| R-RESP-1 | Responses below a configurable size threshold (setting `openapiGateway.inlineResponseThreshold`, default **8 KB**) are inlined in the tool result; including status code and headers. |
| R-RESP-2 | Responses above the threshold are written to a temporary file; the tool result returns the file path/link plus metadata: status line, headers, and body byte size — letting the agent decide how to process the payload (e.g., open, grep, jq, etc.). |
| R-RESP-3 | Binary responses are detected via content type and never inlined into tool results; they follow the temp-file path of R-RESP-2. |

## 4. Tool Contracts

All five tools share conventions:

- Names use the `gateway_` prefix and snake_case (valid for `vscode.lm` tool name constraints): `gateway_list_apis`, `gateway_describe_api`, `gateway_list_operations`, `gateway_describe_operation`, `gateway_invoke_operation`.
- Inputs and outputs are JSON objects; outputs include a stable shape with `content` payloads designed for LLM consumption (concise summaries + structured fields).
- Unknown `apiId` / `operationId` / group values produce error results naming valid alternatives where feasible (e.g., available groups on unknown-group error).

Reference input schemas (informative; normative shape defined by implementation):

```jsonc
// list_apis
{}

// describe_api
{ "apiId": "string" }

// list_operations
{ "apiId": "string", "groups": ["string"] }   // one or more group names

// describe_operation
{ "apiId": "string", "operationId": "string" }

// invoke_operation
{
  "apiId": "string",
  "operationId": "string",
  "pathParams": { "<name>": "string" },
  "queryParams": { "<name>": "string|number|boolean|array" },
  "headers": { "<name>": "string" },
  "body": "any — validated against the operation's request-body schema"
}
```

## 5. Non-Functional Requirements and Constraints

| ID | Constraint |
| ---- | ------------ |
| NFR-1 | Secrets (Bearer tokens) live only in `SecretStorage`; never logged, never echoed into tool results, never written to settings or state files. |
| NFR-2 | Spec URLs must be validated; responses are size-limited during fetch to avoid resource exhaustion. |
| NFR-3 | Tool descriptions and error messages are written for model consumption: specific, actionable, and free of secrets. |
| NFR-4 | Discovery tools respond from in-memory registry state; no network calls occur during discovery (fetching is confined to activation/refresh). |
| NFR-5 | Implementation builds on the existing TypeScript + esbuild extension scaffold and packages with `vsce`. |
| NFR-6 | Core logic (ID derivation, grouping, schema resolution, request building) is unit-testable independent of the VS Code API; integration tests use `@vscode/test-cli`. |

## 6. Resolved and Open Questions

Resolved decisions (2026-08-23):

1. **Inline-response size threshold:** default 8 KB, configurable via `openapiGateway.inlineResponseThreshold`.
2. **Multiple `servers`:** the user confirms a single base URL at registration time (R-REG-9): when several servers are declared a QuickPick selects one, then an editable confirmation prompt (always shown) lets the user override the value; `invoke_operation` uses only that registered base URL. No server selection at invocation time in MVP.
3. **"Always allow" grants:** feature deferred entirely post-MVP (see Non-Goals); stale-grant semantics become moot until grants are introduced.

Open questions:

- None currently.
