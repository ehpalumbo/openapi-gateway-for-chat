import * as vscode from 'vscode';
import { DiscoveryResult } from '../../../application';

export function textResult(payload: unknown): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2))]);
}

export function errorResult(message: string): vscode.LanguageModelToolResult {
	return textResult({ error: message });
}

export function noApisRegistered(): vscode.LanguageModelToolResult {
	return errorResult(
		'No APIs registered. Ask the user to register one with the "OpenAPI Gateway: Register API" commands first.'
	);
}

export function renderDiscoveryResult<T>(result: DiscoveryResult<T>): vscode.LanguageModelToolResult {
	switch (result.kind) {
		case 'success':
			return textResult(result.data);
		case 'no_apis':
			return noApisRegistered();
		case 'unknown_api':
			return errorResult(`Unknown apiId "${result.apiId}". Registered APIs: ${result.availableApis.join(', ') || '(none)'}.`);
		case 'unknown_operation':
			return errorResult(
				`Unknown operationId "${result.operationId}". Available operations: ${result.availableOperations.join(', ') || '(none)'}.`
			);
	}
}
