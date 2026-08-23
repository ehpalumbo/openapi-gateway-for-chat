/**
 * Aggregates the four gateway registration commands (R-REG-1..3, 6).
 *
 * Command modules export plain handlers accepting the shared context; this is
 * the only place they are bound to VS Code command IDs. Re-exported symbols
 * are consumed by integration tests and activation.
 */
import * as vscode from 'vscode';
import { CommandContext } from './common';
import { refreshApis } from './refresh';
import { registerFromFile as registerApiFromFile, registerFromUrl as registerApiFromUrl } from './register';
import { unregisterApi } from './unregister';

export { buildSnapshot, CommandContext, createRegistration, loadSpecFromSource, resolveBaseUrlSuggestion, slugifyTitle } from './common';
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
