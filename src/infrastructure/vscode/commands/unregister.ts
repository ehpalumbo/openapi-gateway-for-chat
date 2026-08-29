import * as vscode from 'vscode';
import { CommandContext } from './common';

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
	const confirm = await vscode.window.showWarningMessage(
		`Unregister API "${picked.label}"?`,
		{ modal: true },
		'Unregister'
	);
	if (confirm !== 'Unregister') {
		return;
	}
	const removed = await ctx.unregisterUseCase.execute(picked.label);
	if (removed) {
		ctx.onChange();
		void vscode.window.showInformationMessage(`Unregistered API "${picked.label}".`);
	}
}
