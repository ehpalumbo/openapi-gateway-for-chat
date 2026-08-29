import * as vscode from 'vscode';
import { CommandContext } from './common';

export async function refreshAll(ctx: CommandContext): Promise<string[]> {
	const failures = await ctx.refreshUseCase.execute();
	if (failures.length > 0) {
		void vscode.window.showWarningMessage(
			`OpenAPI Gateway: ${failures.length} API${failures.length === 1 ? '' : 's'} could not be refreshed and kept their last known state.\n${failures.join('\n')}`
		);
	}
	ctx.onChange();
	return failures;
}

export function refreshApis(ctx: CommandContext): Promise<string[]> {
	return refreshAll(ctx);
}
