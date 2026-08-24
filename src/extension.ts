import * as vscode from 'vscode';
import { ApiRegistry } from './store/registry';
import { TokenStore } from './store/secrets';
import { CommandContext, refreshAll, registerApiCommands } from './vscode/commands/index';
import { registerGatewayTools, ToolContext } from './vscode/tools';

export function activate(context: vscode.ExtensionContext) {
	const registry = new ApiRegistry(context.globalState);
	const tokens = new TokenStore(context.secrets);

	// Tools re-register on every registry change so discovery always reflects
	// the current snapshot set (NFR-4): dispose the previous set first.
	const toolContext: ToolContext = { registry, tokens };
	let toolDisposables = registerGatewayTools(toolContext);

	const commandContext: CommandContext = {
		registry,
		tokens,
		onChange: (): void => {
			toolDisposables.forEach((disposable) => disposable.dispose());
			toolDisposables = registerGatewayTools(toolContext);
		},
	};

	// Disposing this subscription tears down whichever tool set is current,
	// because the closure re-reads `toolDisposables` at dispose time.
	context.subscriptions.push(
		...registerApiCommands(commandContext),
		vscode.Disposable.from({
			dispose: () => {
				toolDisposables.forEach((disposable) => disposable.dispose());
			},
		})
	);

	void refreshAll(commandContext).catch((err: unknown) => {
		void vscode.window.showErrorMessage(
			`OpenAPI Gateway: initial refresh failed: ${err instanceof Error ? err.message : String(err)}`
		);
	});
}

export function deactivate() { }
