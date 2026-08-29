import * as vscode from 'vscode';
import { CommandContext } from './common';
import { refreshApis } from './refresh';
import { registerFromFile, registerFromUrl } from './register';
import { unregisterApi } from './unregister';

export type { CommandContext } from './common';
export { refreshAll } from './refresh';

const COMMAND_PREFIX = 'openapi-gateway-for-chat';

export function registerApiCommands(ctx: CommandContext): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand(`${COMMAND_PREFIX}.registerApiFromUrl`, () => registerFromUrl(ctx)),
		vscode.commands.registerCommand(`${COMMAND_PREFIX}.registerApiFromFile`, () => registerFromFile(ctx)),
		vscode.commands.registerCommand(`${COMMAND_PREFIX}.unregisterApi`, () => unregisterApi(ctx)),
		vscode.commands.registerCommand(`${COMMAND_PREFIX}.refreshApis`, () => refreshApis(ctx)),
	];
}
