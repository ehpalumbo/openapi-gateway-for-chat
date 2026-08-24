import * as vscode from 'vscode';
import { ApiRegistry } from './store/registry';
import { TokenStore } from './store/secrets';
import { CommandContext, refreshAll, registerApiCommands } from './vscode/commands/index';
import { registerGatewayTools } from './vscode/tools';

export function activate(context: vscode.ExtensionContext) {
	const registry = new ApiRegistry(context.globalState);
	const tokens = new TokenStore(context.secrets);
	const tools = registerGatewayTools(registry);
	const ctx: CommandContext = {
		registry,
		tokens,
		onChange: () => {
			// Tools re-register on every registry change so discovery always
			// reflects the current snapshot set (NFR-4).
			tools.refresh();
		},
	};

	context.subscriptions.push(...registerApiCommands(ctx), tools);

	void refreshAll(ctx).catch((err: unknown) => {
		void vscode.window.showErrorMessage(
			`OpenAPI Gateway: initial refresh failed: ${err instanceof Error ? err.message : String(err)}`
		);
	});
}

export function deactivate() { }
