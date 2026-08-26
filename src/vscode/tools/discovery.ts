/**
 * The four read-only discovery tools (R-DISC-*).
 *
 * Thin adapters only: every `invoke` reads purely from the registry's
 * in-memory views (NFR-4 — no network I/O during discovery) and wraps the
 * core builders' plain-JSON output into a single-text-part tool result.
 * None of these tools declares confirmation.
 *
 * The host validates `options.input` against the `inputSchema` declared in
 * package.json before dispatching (`vscode.d.ts:21166`), so inputs are
 * consumed directly without runtime coercion.
 */
import * as vscode from 'vscode';
import {
	buildDescribeApi,
	buildDescribeOperation,
	buildListApis,
	buildListOperations,
} from '../../core/describe';
import { isFailure, noApisRegistered, resolveEntry, textResult } from './common';
import { ToolContext } from './context';

/**
 * Typed input shape for the `gateway_list_apis` tool.
 */
export type ListApisInput = Record<string, never>;

/**
 * Typed input shape for the `gateway_describe_api` tool.
 */
export interface DescribeApiInput {
	apiId: string;
}

/**
 * Typed input shape for the `gateway_list_api_operations` tool.
 */
export interface ListOperationsInput {
	apiId: string;
	groups: string[];
}
/**
 * Typed input shape for the `gateway_describe_api_operation` tool.
 */
export interface DescribeOperationInput {
	apiId: string;
	operationId: string;
}

/**
 * Creates the `gateway_list_apis` tool, which lists all registered APIs.
 *
 * @param context - Shared tool dependencies.
 * @returns A `LanguageModelTool` that lists all registered APIs.
 */
export function createListApisTool(context: ToolContext): vscode.LanguageModelTool<ListApisInput> {
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

/**
 * Creates the `gateway_describe_api` tool, which describes a registered API.
 *
 * @param context - Shared tool dependencies.
 * @returns A `LanguageModelTool` that describes a registered API.
 */
export function createDescribeApiTool(context: ToolContext): vscode.LanguageModelTool<DescribeApiInput> {
	return {
		invoke: (options) => {
			const { apiId } = options.input;
			const found = resolveEntry(context.registry, apiId);
			if (isFailure(found)) {
				return found;
			}
			return textResult(buildDescribeApi(found.registration));
		},
	};
}

/**
 * Creates the `gateway_list_api_operations` tool, which lists operations of a
 * registered API.
 *
 * @param context - Shared tool dependencies.
 * @returns A `LanguageModelTool` that lists operations of a registered API.
 */
export function createListOperationsTool(context: ToolContext): vscode.LanguageModelTool<ListOperationsInput> {
	return {
		invoke: (options) => {
			const { apiId, groups } = options.input;
			const found = resolveEntry(context.registry, apiId);
			if (isFailure(found)) {
				return found;
			}
			return textResult(buildListOperations(found.registration, groups));
		},
	};
}

/**
 * Creates the `gateway_describe_api_operation` tool, which describes a specific
 * operation of a registered API.
 *
 * @param context - Shared tool dependencies.
 * @returns A `LanguageModelTool` that describes a specific operation of a
 * registered API.
 */
export function createDescribeOperationTool(
	context: ToolContext
): vscode.LanguageModelTool<DescribeOperationInput> {
	return {
		invoke: (options) => {
			const { apiId, operationId } = options.input;
			const found = resolveEntry(context.registry, apiId);
			if (isFailure(found)) {
				return found;
			}
			return textResult(buildDescribeOperation(found.registration, found.index, operationId));
		},
	};
}
