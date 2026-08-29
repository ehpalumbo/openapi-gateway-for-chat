import * as vscode from 'vscode';
import { ToolContext } from './context';
import {
	createDescribeApiTool,
	createDescribeOperationTool,
	createListApisTool,
	createListOperationsTool,
} from './discovery';
import { createInvokeOperationTool } from './invocation';

export type { ToolContext } from './context';
export {
	createDescribeApiTool,
	createDescribeOperationTool,
	createListApisTool,
	createListOperationsTool
} from './discovery';
export { createInvokeOperationTool } from './invocation';

/**
 * Registers all gateway tools into VS Code.
 *
 * @param ctx - Shared tool dependencies.
 * @returns Disposables to push onto the extension context.
 */
export function registerGatewayTools(ctx: ToolContext): vscode.Disposable[] {
	return [
		vscode.lm.registerTool('gateway_list_apis', createListApisTool(ctx)),
		vscode.lm.registerTool('gateway_describe_api', createDescribeApiTool(ctx)),
		vscode.lm.registerTool('gateway_list_api_operations', createListOperationsTool(ctx)),
		vscode.lm.registerTool('gateway_describe_api_operation', createDescribeOperationTool(ctx)),
		vscode.lm.registerTool('gateway_invoke_operation', createInvokeOperationTool(ctx)),
	];
}
