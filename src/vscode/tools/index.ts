/**
 * Activation-facing surface of the tool layer: binds the five gateway tools
 * (R-DISC-*, R-INV-*) to their contributed names and registers them with
 * `vscode.lm`, mirroring how `registerApiCommands` binds command IDs to
 * `vscode.commands`.
 *
 * Per the Language Model Tools API, each tool's model-facing description and
 * input schema are declared in package.json under
 * `contributes.languageModelTools`; this module registers only the
 * implementations. Tests import the factories from `./discovery` /
 * `./invocation` directly. `vscode.lm.registerTool` is generic over the
 * input type, so each binding preserves its concrete input shape.
 */
import * as vscode from 'vscode';
import { ToolContext } from './context';
import { createDescribeApiTool, createDescribeOperationTool, createListApisTool, createListOperationsTool } from './discovery';
import { createInvokeOperationTool } from './invocation';

export type { ToolContext } from './context';

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
