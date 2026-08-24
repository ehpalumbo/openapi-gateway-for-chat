/**
 * Shared dependencies of the gateway tool implementations, mirroring the
 * `CommandContext` pattern used by the command handlers.
 *
 * Kept structural (no class) so tests can supply fakes without constructing
 * real VS Code stores.
 */
import type * as vscode from 'vscode';
import type { ApiRegistry } from '../../store/registry';
import type { TokenStore } from '../../store/secrets';

/**
 * The only token capability the invoke tool needs: reading a stored token.
 */
export type TokenSource = Pick<TokenStore, 'getToken'>;

/**
 * Dependencies every gateway tool factory receives.
 */
export interface ToolContext {
	/** Registry whose in-memory views back all tool responses. */
	registry: ApiRegistry;
	/** Token store backing Bearer-authenticated invocations. */
	tokens: TokenSource;
}

/**
 * Builds one `LanguageModelTool` implementation for a contributed tool name.
 */
export type ToolFactory = (context: ToolContext) => vscode.LanguageModelTool<unknown>;
