# OpenAPI Gateway for Chat

Expose remote REST APIs to AI agents in VS Code as native language model tools. Register APIs with OpenAPI 3.0/3.1 specifications via extension commands; the extension registers language model tools (`vscode.lm`) that let Copilot Chat agents and other language model consumers progressively discover and invoke those APIs.

## Why this extension exists

The same use case is achievable today with MCP servers derived from OpenAPI specs, which VS Code supports natively. However, there are two practical limitations:

- Deriving, hosting, and running MCP servers per API may be considered an operational burden.
- Some users working in enterprise environments lack permission to enable/use MCP servers in VS Code.

The extension is therefore a **convenience layer**: no external processes, no extra infrastructure — registration happens entirely inside the editor.

## Features

- **Register APIs** from a URL or workspace file (OpenAPI 3.0.x / 3.1.x), persisted globally across workspaces.
- **Progressive disclosure discovery tools**: `list_apis` → `describe_api` → `list_operations` → `describe_operation`.
- **Invocation tool**: `invoke_operation` with structured tool input validation against the spec.
- **Safe by default**: non-safe HTTP methods require explicit user confirmation before each call.
- **Static Bearer-token auth**, stored securely in VS Code SecretStorage.
- **Size-aware responses**: small responses returned inline; large ones written to a temp file with status/header/size metadata.

See [docs/index.md](docs/index.md) for the full software specification.

## Requirements

- VS Code with the Language Model Tools API available (`vscode.lm.tools`), e.g. GitHub Copilot Chat enabled for agent tool use.

## Extension Settings

None yet; planned: inline response size threshold, revocation of "always allow" grants.

## Known Issues

See the specification's Open Questions section in [docs/specs/software-specification.md](docs/specs/software-specification.md).
