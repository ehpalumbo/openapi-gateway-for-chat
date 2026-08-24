/**
 * Helpers shared by the gateway tool implementations: input coercion and the
 * uniform single-text-part tool-result shapes (spec §4).
 */
import * as vscode from 'vscode';
import { ApiRegistry, RegistryEntry } from '../../store/registry';

export function textResult(payload: unknown): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2))]);
}

export function errorResult(message: string): vscode.LanguageModelToolResult {
	return textResult({ error: message });
}

export function asRecord(input: unknown): Record<string, unknown> {
	return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

export function readString(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function noApisRegistered(): vscode.LanguageModelToolResult {
	return errorResult(
		'No APIs registered. Ask the user to register one with the "OpenAPI Gateway: Register API" commands first.'
	);
}

/**
 * Looks up a registry entry by ID, returning an error result for empty
 * registries or unknown IDs instead of throwing (spec §4).
 */
export function resolveEntry(registry: ApiRegistry, apiId: string): RegistryEntry | vscode.LanguageModelToolResult {
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

export function isFailure(value: RegistryEntry | vscode.LanguageModelToolResult): value is vscode.LanguageModelToolResult {
	return value instanceof vscode.LanguageModelToolResult;
}
