# OpenAPI Gateway for Chat

Expose remote REST APIs to AI agents in VS Code as native language model tools. Register APIs with OpenAPI 3.0/3.1 specifications via extension commands; the extension registers language model tools (`vscode.lm`) that let Copilot Chat agents and other language model consumers progressively discover and invoke those APIs.

## Why this extension exists

The same use case is achievable today with MCP servers derived from OpenAPI specs, which VS Code supports natively. However, there are two practical limitations:

- Deriving, hosting, and running MCP servers per API may be considered an operational burden.
- Some users working in enterprise environments lack permission to enable/use MCP servers in VS Code.

The extension is therefore a **convenience layer**: no external processes, no extra infrastructure — registration happens entirely inside the editor.

## Features

- **Register APIs** from a URL or workspace file (OpenAPI 3.0.x / 3.1.x), persisted globally across workspaces.
- **Progressive disclosure discovery tools**: `gateway_list_apis` → `gateway_describe_api` → `gateway_list_api_operations` → `gateway_describe_api_operation`.
- **Invocation tool**: `gateway_invoke_operation` with structured tool input validation against the spec.
- **Safe by default**: non-safe HTTP methods require explicit user confirmation before each call, with redacted headers and a body preview.
- **Static Bearer-token auth**, stored securely in VS Code SecretStorage.
- **Uniform response serving**: every HTTP response arrives as two parts — JSON metadata (status, status line, headers) plus the body routed by content type.

See [docs/index.md](docs/index.md) for the full software specification.

## Commands

All commands live under the **OpenAPI Gateway** category:

| Command | Purpose |
| --- | --- |
| `OpenAPI Gateway: Register API from URL` | Fetch an OpenAPI JSON document over http(s) and register it. |
| `OpenAPI Gateway: Register API from File` | Pick an OpenAPI JSON document from the workspace and register it. |
| `OpenAPI Gateway: Unregister API` | Remove a registered API and its stored token. |
| `OpenAPI Gateway: Refresh APIs` | Re-fetch/re-read every registered spec to pick up changes. |

### Registration walkthrough

1. Run one of the two register commands.
2. Enter a unique **API identifier** (`apiId`) — pre-filled from the spec title; conflicts are rejected with a prompt.
3. Confirm or override the **base URL** used for invocations — pre-filled from the spec's first declared server; multi-server specs offer a picker first.
4. Optionally enter a **Bearer token**; it is stored in VS Code SecretStorage and never displayed again.

## Language model tools

Agents see five tools (names as contributed):

| Tool | Purpose |
| --- | --- |
| `gateway_list_apis` | List registered APIs; entry point for discovery. |
| `gateway_describe_api` | Show one API's metadata and operation groups. |
| `gateway_list_api_operations` | List operations within a group. |
| `gateway_describe_api_operation` | Show one operation's parameters, request body schema, and usage examples. |
| `gateway_invoke_operation` | Execute an operation against the registered base URL. |

## How responses are served

Every response carrying an HTTP status is returned as exactly two tool-result parts:

1. **Metadata** — a text part containing JSON `{ status, statusLine, headers }`, so the model can read the status code and headers directly.
2. **Body** — routed by content type:
   - Textual types (`text/*`, `application/json`, `+json`): a text part with the UTF-8 body, served whole.
   - Vision-safe images (`image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/bmp`): an image `LanguageModelDataPart`.
   - Any other binary (PDFs, octet-stream, …): written via `vscode.workspace.fs` to `<storageUri>/response-spills/<apiId>-<operationId>-<uuid>.<ext>` — uniquely named so concurrent calls never override each other — and referenced from a text part with content type, byte size, and the absolute path. Spilled files are deleted on extension deactivation.

Non-2xx statuses are not special-cased: the model detects failure from the metadata part and receives the full error body. Only failures without a status — network errors — fall back to a plain text result describing the connectivity problem.

> Why not return all bodies as data parts? Copilot Chat forwards only text parts and image data parts from tool results into the model prompt; other `LanguageModelDataPart`s are silently dropped (microsoft/vscode#275300). Spill files are the only way non-image binaries can reach the agent at all.

## Requirements

- VS Code with the Language Model Tools API available (`vscode.lm.tools`), e.g. GitHub Copilot Chat enabled for agent tool use.

## Extension Settings

This extension contributes no settings.

## Development

```bash
npm install        # install dependencies
npm run compile    # type-check, lint, and bundle
npm test           # unit suites (pure Node/mocha) + integration suites (vscode-test)
```

Integration tests start an ephemeral local HTTP server inside VS Code's extension host; no network access beyond `127.0.0.1` is required.

## Security notes

- Bearer tokens are kept exclusively in VS Code **SecretStorage**; they never appear in logs, confirmations, or tool results.
- Non-safe methods require explicit confirmation showing the resolved URL and headers with `Authorization: Bearer ***`.
- Error messages name the failing parameter or endpoint without echoing token values.

## Limitations

- Only OpenAPI **3.0.x / 3.1.x documents in JSON format** are supported; YAML specs are rejected with guidance.
- Only static **Bearer-token auth** is supported; OAuth flows, API keys in cookies, etc. are out of scope for now.

## Known Issues

See the specification's Open Questions section in [docs/specs/software-specification.md](docs/specs/software-specification.md).
