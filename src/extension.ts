import * as vscode from 'vscode';
import {
	DiscoveryUseCases,
	InvokeOperationUseCase,
	RefreshApisUseCase,
	RegisterApiUseCase,
	SpillStore,
	UnregisterApiUseCase,
} from './application';
import {
	CommandContext,
	FetchHttpClient,
	FetchSpecLoader,
	FileBackedApiRegistry,
	refreshAll,
	registerApiCommands,
	registerGatewayTools,
	SecretTokenStore,
	ToolContext,
	WorkspaceSpillStore,
} from './infrastructure';

/** Kept at module scope so `deactivate` can clean up spills after teardown. */
let spillStore: SpillStore | undefined;

export function activate({ globalState, secrets, storageUri, globalStorageUri, subscriptions }: vscode.ExtensionContext) {
	if (!globalStorageUri) {
		throw new Error('OpenAPI Gateway requires global storage to be available (globalStorageUri is undefined).');
	}
	// 1. Infrastructure Adapters
	const registry = new FileBackedApiRegistry(globalState, globalStorageUri);
	const tokens = new SecretTokenStore(secrets);
	spillStore = new WorkspaceSpillStore(storageUri ?? globalStorageUri);
	const httpClient = new FetchHttpClient();
	const specLoader = new FetchSpecLoader();

	// 2. Application Use Cases
	const registerUseCase = new RegisterApiUseCase(registry, tokens);
	const unregisterUseCase = new UnregisterApiUseCase(registry, tokens);
	const refreshUseCase = new RefreshApisUseCase(registry, specLoader);
	const discoveryUseCases = new DiscoveryUseCases(registry);
	const invokeUseCase = new InvokeOperationUseCase(registry, tokens, httpClient);

	// 3. Presentation / Framework Adapters (Tools & Commands)
	const toolContext: ToolContext = {
		registry,
		tokens,
		spills: spillStore,
		discoveryUseCases,
		invokeUseCase,
	};
	let toolDisposables = registerGatewayTools(toolContext);

	const commandContext: CommandContext = {
		registry,
		tokens,
		specLoader,
		registerUseCase,
		unregisterUseCase,
		refreshUseCase,
		onChange: (): void => {
			toolDisposables.forEach((disposable) => disposable.dispose());
			toolDisposables = registerGatewayTools(toolContext);
		},
	};

	subscriptions.push(
		...registerApiCommands(commandContext),
		vscode.Disposable.from({
			dispose: () => {
				toolDisposables.forEach((disposable) => disposable.dispose());
			},
		})
	);

	refreshAll(commandContext).catch((err: unknown) => {
		vscode.window.showErrorMessage(
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
