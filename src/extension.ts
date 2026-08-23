import * as vscode from 'vscode';
import { CommandContext, refreshAll, registerApiCommands } from './vscode/commands/index';
import { ApiRegistry } from './store/registry';
import { TokenStore } from './store/secrets';

/**
 * Registers the gateway language-model tools.
 *
 * Stubbed until Phase 3 lands; returns the disposables owning the tools so
 * this phase compiles and runs standalone.
 */
function registerGatewayTools(_ctx: CommandContext): vscode.Disposable[] {
	return [];
}

export function activate(context: vscode.ExtensionContext) {
	const registry = new ApiRegistry(context.globalState);
	const tokens = new TokenStore(context.secrets);
	const ctx: CommandContext = {
		registry,
		tokens,
		onChange: () => {
			// Tools re-register on every registry change (Phase 3).
		},
	};

	context.subscriptions.push(...registerApiCommands(ctx), ...registerGatewayTools(ctx));

	void refreshAll(ctx).catch((err: unknown) => {
		void vscode.window.showErrorMessage(
			`OpenAPI Gateway: initial refresh failed: ${err instanceof Error ? err.message : String(err)}`
		);
	});
}

export function deactivate() {}
