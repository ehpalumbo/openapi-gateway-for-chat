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
 * `./invocation` directly.
 */
import * as vscode from 'vscode';
import { ToolContext, ToolFactory } from './context';
import { createDescribeApiTool, createDescribeOperationTool, createListApisTool, createListOperationsTool } from './discovery';
import { createInvokeOperationTool } from './invocation';

export type { ToolContext } from './context';

/** The agent-facing gateway tools and how their implementations are built. */
const TOOL_FACTORIES: readonly (readonly [name: string, factory: ToolFactory])[] = [
	['gateway_list_apis', createListApisTool],
	['gateway_describe_api', createDescribeApiTool],
	['gateway_list_operations', createListOperationsTool],
	['gateway_describe_operation', createDescribeOperationTool],
	['gateway_invoke_operation', createInvokeOperationTool],
];

/**
 * Registers all gateway tools into VS Code.
 *
 * @param ctx - Shared tool dependencies.
 * @returns Disposables to push onto the extension context.
 */
export function registerGatewayTools(ctx: ToolContext): vscode.Disposable[] {
	return TOOL_FACTORIES.map(([name, factory]) => vscode.lm.registerTool(name, factory(ctx)));
}
