/**
 * Unregister command (R-REG-3): pick an API, confirm, remove registration and
 * its stored token.
 */
import * as vscode from 'vscode';
import { CommandContext } from './common';

/**
 * Handler for R-REG-3: pick an API, confirm, remove registration and its
 * stored token.
 */
export async function unregisterApi(ctx: CommandContext): Promise<void> {
	const registrations = ctx.registry.list();
	if (registrations.length === 0) {
		void vscode.window.showInformationMessage('No APIs are registered.');
		return;
	}
	const picked = await vscode.window.showQuickPick(
		registrations.map((reg) => ({ label: reg.apiId, description: `${reg.title} ${reg.version}` })),
		{ placeHolder: 'Select the API to unregister' }
	);
	if (!picked) {
		return;
	}
	const confirm = await vscode.window.showWarningMessage(`Unregister API "${picked.label}"?`, { modal: true }, 'Unregister');
	if (confirm !== 'Unregister') {
		return;
	}
	ctx.registry.remove(picked.label);
	await ctx.tokens.deleteToken(picked.label);
	ctx.onChange();
	void vscode.window.showInformationMessage(`Unregistered API "${picked.label}".`);
}
