/**
 * Refresh logic (R-REG-6, R-REG-7) shared by activation and the refreshApis
 * command.
 */
import * as vscode from 'vscode';
import { SpecSource } from '../../core/types';
import { CommandContext, buildSnapshot, loadSpecFromSource } from './common';

/**
 * Refreshes every registered API sequentially.
 *
 * A failure keeps that API's last-good snapshot intact and is collected;
 * remaining APIs still refresh. Failures are surfaced once at the end.
 *
 * @param ctx - Registry plus change callback.
 * @param load - Spec loader; injectable for tests.
 * @returns One human-readable failure description per API that kept its snapshot.
 */
export async function refreshAll(ctx: CommandContext, load: (source: SpecSource) => Promise<string> = loadSpecFromSource): Promise<string[]> {
	const failures: string[] = [];
	for (const registration of ctx.registry.list()) {
		try {
			const text = await load(registration.source);
			ctx.registry.replaceSnapshot(registration.apiId, buildSnapshot(text));
		} catch (err) {
			failures.push(`${registration.apiId}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (failures.length > 0) {
		void vscode.window.showWarningMessage(
			`OpenAPI Gateway: ${failures.length} API${failures.length === 1 ? '' : 's'} could not be refreshed and kept their last known state.\n${failures.join('\n')}`
		);
	}
	ctx.onChange();
	return failures;
}

/**
 * Handler for R-REG-6: refreshes all registrations on command invocation.
 */
export function refreshApis(ctx: CommandContext): Promise<string[]> {
	return refreshAll(ctx);
}
