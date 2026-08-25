import * as vscode from 'vscode';
import { ApiRegistry } from './store/registry';
import { TokenStore } from './store/secrets';
import { CommandContext, refreshAll, registerApiCommands } from './vscode/commands/index';
import { WorkspaceSpillStore, SpillStore } from './vscode/spills';
import { registerGatewayTools, ToolContext } from './vscode/tools';

/** Kept at module scope so `deactivate` can clean up spills after teardown. */
let spillStore: SpillStore | undefined;

export function activate(context: vscode.ExtensionContext) {
	const registry = new ApiRegistry(context.globalState);
	const tokens = new TokenStore(context.secrets);
	spillStore = new WorkspaceSpillStore(context.storageUri ?? context.globalStorageUri);

	// Tools re-register on every registry change so discovery always reflects
	// the current snapshot set (NFR-4): dispose the previous set first.
	const toolContext: ToolContext = { registry, tokens, spills: spillStore };
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

/**
 * Best-effort removal of every spilled binary response body created during
 * this session (R-RESP-3): the model never needs them across window reloads.
 */
export async function deactivate(): Promise<void> {
	await spillStore?.cleanup();
	spillStore = undefined;
}
