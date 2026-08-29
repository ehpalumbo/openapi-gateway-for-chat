import * as vscode from 'vscode';
import { renderDiscoveryResult } from './common';
import { ToolContext } from './context';

export type ListApisInput = Record<string, never>;

export interface DescribeApiInput {
	apiId: string;
}

export interface ListOperationsInput {
	apiId: string;
	groups: string[];
}

export interface DescribeOperationInput {
	apiId: string;
	operationId: string;
}

export function createListApisTool(context: ToolContext): vscode.LanguageModelTool<ListApisInput> {
	return {
		invoke: () => {
			const result = context.discoveryUseCases.listApis();
			return renderDiscoveryResult(result);
		},
	};
}

export function createDescribeApiTool(context: ToolContext): vscode.LanguageModelTool<DescribeApiInput> {
	return {
		invoke: (options) => {
			const result = context.discoveryUseCases.describeApi(options.input.apiId);
			return renderDiscoveryResult(result);
		},
	};
}

export function createListOperationsTool(context: ToolContext): vscode.LanguageModelTool<ListOperationsInput> {
	return {
		invoke: (options) => {
			const { apiId, groups } = options.input;
			const result = context.discoveryUseCases.listOperations(apiId, groups);
			return renderDiscoveryResult(result);
		},
	};
}

export function createDescribeOperationTool(
	context: ToolContext
): vscode.LanguageModelTool<DescribeOperationInput> {
	return {
		invoke: (options) => {
			const { apiId, operationId } = options.input;
			const result = context.discoveryUseCases.describeOperation(apiId, operationId);
			return renderDiscoveryResult(result);
		},
	};
}
