/**
 * Activation-facing surface of the command layer: binds the four gateway
 * registration commands (R-REG-1..3, 6) to their VS Code command IDs and
 * exposes only what extension activation needs.
 *
 * Internal helpers stay in `./common` / `./refresh`; tests import those
 * modules directly.
 */
import * as vscode from 'vscode';
import { CommandContext } from './common';
import { refreshApis } from './refresh';
import { registerFromFile as registerApiFromFile, registerFromUrl as registerApiFromUrl } from './register';
import { unregisterApi } from './unregister';

export type { CommandContext } from './common';
export { refreshAll } from './refresh';

const COMMAND_PREFIX = 'openapi-gateway-for-chat';

/**
 * Registers all gateway commands into VS Code.
 *
 * @param ctx - Shared command dependencies.
 * @returns Disposables to push onto the extension context.
 */
export function registerApiCommands(ctx: CommandContext): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand(`${COMMAND_PREFIX}.registerApiFromUrl`, () => registerApiFromUrl(ctx)),
		vscode.commands.registerCommand(`${COMMAND_PREFIX}.registerApiFromFile`, () => registerApiFromFile(ctx)),
		vscode.commands.registerCommand(`${COMMAND_PREFIX}.unregisterApi`, () => unregisterApi(ctx)),
		vscode.commands.registerCommand(`${COMMAND_PREFIX}.refreshApis`, () => refreshApis(ctx)),
	];
}
