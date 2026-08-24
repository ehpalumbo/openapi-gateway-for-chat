/**
 * Wiring of the discovery tools onto `vscode.lm.registerTool` (R-DISC-*).
 *
 * Thin adapters only: every `invoke` reads purely from the registry's
 * in-memory views (NFR-4 — no network I/O during discovery) and wraps the
 * core builders' plain-JSON output into a single-text-part tool result.
 *
 * Per the Language Model Tools API, each tool's model-facing description and
 * input schema are declared in package.json under `contributes.languageModelTools`;
 * this module registers only the implementations. `registerGatewayTools` is
 * the single place calling `vscode.lm.registerTool`, driven by a name/factory
 * table whose factories build the {@link vscode.LanguageModelTool} objects.
 *
 * Tools are re-registered whenever the registry changes so discovery never
 * sees stale data: `refresh()` disposes the previous set and registers afresh.
 * The four tools are read-only and declare no confirmation; safety
 * confirmation belongs to `gateway_invoke_operation` (Phase 4, R-SAFE-*).
 */
import * as vscode from 'vscode';
import {
	buildDescribeApi,
	buildDescribeOperation,
	buildListApis,
	buildListOperations,
} from '../core/describe';
import { ApiRegistry, RegistryEntry } from '../store/registry';

type ToolFactory = (registry: ApiRegistry) => vscode.LanguageModelTool<unknown>;

/** The read-only discovery tools and how their implementations are built. */
const TOOL_FACTORIES: readonly (readonly [name: string, factory: ToolFactory])[] = [
	['gateway_list_apis', createListApisTool],
	['gateway_describe_api', createDescribeApiTool],
	['gateway_list_operations', createListOperationsTool],
	['gateway_describe_operation', createDescribeOperationTool],
];

/**
 * Registers the four discovery tools.
 *
 * @param registry - Registry whose views back all tool responses.
 * @returns A handle whose `refresh()` unregisters and re-registers the tools;
 *          `dispose()` unregisters them permanently. Callers should
 *          wire it to the registry-change callback after any mutation.
 */
export function registerGatewayTools(registry: ApiRegistry): { refresh(): void; dispose(): void; } {
	let current: vscode.Disposable[] = [];

	const disposeCurrent = (): void => {
		for (const disposable of current) {
			disposable.dispose();
		}
		current = [];
	};

	const registerAll = (): void => {
		disposeCurrent();
		current = TOOL_FACTORIES.map(([name, factory]) => vscode.lm.registerTool(name, factory(registry)));
	};

	registerAll();

	return {
		refresh: registerAll,
		dispose: disposeCurrent,
	};
}

function textResult(payload: unknown): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2))]);
}

function errorResult(message: string): vscode.LanguageModelToolResult {
	return textResult({ error: message });
}

function asRecord(input: unknown): Record<string, unknown> {
	return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function noApisRegistered(): vscode.LanguageModelToolResult {
	return errorResult(
		'No APIs registered. Ask the user to register one with the "OpenAPI Gateway: Register API" commands first.'
	);
}

/**
 * Looks up a registry entry by ID, returning an error result for empty
 * registries or unknown IDs instead of throwing (spec §4).
 */
function resolveEntry(registry: ApiRegistry, apiId: string): RegistryEntry | vscode.LanguageModelToolResult {
	if (registry.list().length === 0) {
		return noApisRegistered();
	}
	const entry = registry.getEntry(apiId);
	if (!entry) {
		const available = registry
			.list()
			.map((registered) => registered.apiId)
			.join(', ');
		return errorResult(`Unknown apiId "${apiId}". Registered APIs: ${available}.`);
	}
	return entry;
}

function isFailure(value: RegistryEntry | vscode.LanguageModelToolResult): value is vscode.LanguageModelToolResult {
	return value instanceof vscode.LanguageModelToolResult;
}

function createListApisTool(registry: ApiRegistry): vscode.LanguageModelTool<unknown> {
	return {
		invoke: () => {
			const registrations = registry.list();
			if (registrations.length === 0) {
				return noApisRegistered();
			}
			return textResult({ apis: buildListApis(registrations) });
		},
	};
}

function createDescribeApiTool(registry: ApiRegistry): vscode.LanguageModelTool<unknown> {
	return {
		invoke: (options) => {
			const apiId = readString(asRecord(options.input), 'apiId');
			if (!apiId) {
				return errorResult('Missing required string parameter "apiId".');
			}
			const found = resolveEntry(registry, apiId);
			if (isFailure(found)) {
				return found;
			}
			return textResult(buildDescribeApi(found.registration));
		},
	};
}

function createListOperationsTool(registry: ApiRegistry): vscode.LanguageModelTool<unknown> {
	return {
		invoke: (options) => {
			const input = asRecord(options.input);
			const apiId = readString(input, 'apiId');
			if (!apiId) {
				return errorResult('Missing required string parameter "apiId".');
			}
			const found = resolveEntry(registry, apiId);
			if (isFailure(found)) {
				return found;
			}
			const rawGroups = Array.isArray(input['groups']) ? input['groups'] : [];
			const groups = rawGroups.filter((name): name is string => typeof name === 'string');
			return textResult(buildListOperations(found.registration, groups));
		},
	};
}

function createDescribeOperationTool(registry: ApiRegistry): vscode.LanguageModelTool<unknown> {
	return {
		invoke: (options) => {
			const input = asRecord(options.input);
			const apiId = readString(input, 'apiId');
			if (!apiId) {
				return errorResult('Missing required string parameter "apiId".');
			}
			const operationId = readString(input, 'operationId');
			if (!operationId) {
				return errorResult('Missing required string parameter "operationId".');
			}
			const found = resolveEntry(registry, apiId);
			if (isFailure(found)) {
				return found;
			}
			return textResult(buildDescribeOperation(found.registration, found.index, operationId));
		},
	};
}
