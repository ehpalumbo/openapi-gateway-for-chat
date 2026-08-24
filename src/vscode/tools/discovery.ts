/**
 * The four read-only discovery tools (R-DISC-*).
 *
 * Thin adapters only: every `invoke` reads purely from the registry's
 * in-memory views (NFR-4 — no network I/O during discovery) and wraps the
 * core builders' plain-JSON output into a single-text-part tool result.
 * None of these tools declares confirmation.
 */
import * as vscode from 'vscode';
import {
	buildDescribeApi,
	buildDescribeOperation,
	buildListApis,
	buildListOperations,
} from '../../core/describe';
import { asRecord, errorResult, isFailure, noApisRegistered, readString, resolveEntry, textResult } from './common';
import { ToolContext } from './context';

export function createListApisTool(context: ToolContext): vscode.LanguageModelTool<unknown> {
	return {
		invoke: () => {
			const registrations = context.registry.list();
			if (registrations.length === 0) {
				return noApisRegistered();
			}
			return textResult({ apis: buildListApis(registrations) });
		},
	};
}

export function createDescribeApiTool(context: ToolContext): vscode.LanguageModelTool<unknown> {
	return {
		invoke: (options) => {
			const apiId = readString(asRecord(options.input), 'apiId');
			if (!apiId) {
				return errorResult('Missing required string parameter "apiId".');
			}
			const found = resolveEntry(context.registry, apiId);
			if (isFailure(found)) {
				return found;
			}
			return textResult(buildDescribeApi(found.registration));
		},
	};
}

export function createListOperationsTool(context: ToolContext): vscode.LanguageModelTool<unknown> {
	return {
		invoke: (options) => {
			const input = asRecord(options.input);
			const apiId = readString(input, 'apiId');
			if (!apiId) {
				return errorResult('Missing required string parameter "apiId".');
			}
			const found = resolveEntry(context.registry, apiId);
			if (isFailure(found)) {
				return found;
			}
			const rawGroups = Array.isArray(input['groups']) ? input['groups'] : [];
			const groups = rawGroups.filter((name): name is string => typeof name === 'string');
			return textResult(buildListOperations(found.registration, groups));
		},
	};
}

export function createDescribeOperationTool(context: ToolContext): vscode.LanguageModelTool<unknown> {
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
			const found = resolveEntry(context.registry, apiId);
			if (isFailure(found)) {
				return found;
			}
			return textResult(buildDescribeOperation(found.registration, found.index, operationId));
		},
	};
}
