import * as vscode from 'vscode';
import { resolveBaseUrlSuggestion, slugifyTitle } from '../../../application';
import { parseSpec, SpecSource } from '../../../domain';
import { fetchWithLimit, SPEC_FETCH_LIMIT_BYTES } from '../http';
import { CommandContext } from './common';

async function promptForUniqueId(ctx: CommandContext, suggested: string): Promise<string | undefined> {
	let candidate = suggested;
	for (; ;) {
		const entered = await vscode.window.showInputBox({
			prompt: 'Unique API identifier (used by tools to reference this API)',
			value: candidate,
			validateInput: (value) =>
				value.trim().length === 0 ? 'Enter a non-empty identifier.' : undefined,
		});
		if (entered === undefined) {
			return undefined;
		}
		const apiId = entered.trim();
		const existing = ctx.registry.get(apiId);
		if (!existing) {
			return apiId;
		}
		void vscode.window.showErrorMessage(
			`An API "${apiId}" (${existing.title}) is already registered. Choose a different identifier.`
		);
		candidate = apiId;
	}
}

async function promptForBaseUrl(jsonText: string): Promise<string | undefined> {
	const doc = parseSpec(jsonText);
	const servers = doc.servers ?? [];
	let suggestion = resolveBaseUrlSuggestion(doc);
	if (servers.length > 1) {
		const picked = await vscode.window.showQuickPick(
			servers.map((server) => ({ label: server.url, description: server.description })),
			{ placeHolder: 'Select the server to use as base URL' }
		);
		if (picked) {
			suggestion = picked.label;
		}
	}
	return vscode.window.showInputBox({
		prompt: 'Confirm or override the base URL to invoke operations against',
		value: suggestion,
		validateInput: (value) => {
			try {
				const parsed = new URL(value);
				return parsed.protocol === 'http:' || parsed.protocol === 'https:'
					? undefined
					: 'Base URL must be http(s).';
			} catch {
				return 'Enter an absolute http(s) URL.';
			}
		},
	});
}

async function promptForBearerToken(): Promise<string | undefined> {
	return vscode.window.showInputBox({
		prompt: 'Bearer token to send with invocations (optional, stored securely)',
		password: true,
	});
}

async function finalizeRegistration(ctx: CommandContext, jsonText: string, source: SpecSource): Promise<void> {
	let title: string;
	try {
		const doc = parseSpec(jsonText);
		title = doc.info.title;
	} catch (err) {
		void vscode.window.showErrorMessage(`Cannot register API: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	const apiId = await promptForUniqueId(ctx, slugifyTitle(title));
	if (!apiId) {
		return;
	}

	const baseUrl = await promptForBaseUrl(jsonText);
	if (!baseUrl) {
		return;
	}

	const token = await promptForBearerToken();

	const result = await ctx.registerUseCase.execute({
		jsonText,
		apiId,
		baseUrl,
		source,
		token,
	});

	if (result.status === 'conflict') {
		void vscode.window.showErrorMessage(`An API "${apiId}" (${result.existingTitle}) is already registered.`);
		return;
	}

	ctx.onChange();
	const operationsCount = result.registration
		? result.registration.snapshot.model.groups.flatMap((group) => group.operations).length
		: 0;
	void vscode.window.showInformationMessage(
		`Registered API "${title}" as "${apiId}" with ${operationsCount} operations.`
	);
}

export async function registerFromUrl(ctx: CommandContext): Promise<void> {
	const url = await vscode.window.showInputBox({
		prompt: 'URL of an OpenAPI 3.0.x / 3.1.x JSON document',
		placeHolder: 'https://example.com/openapi.json',
		ignoreFocusOut: true,
	});
	if (!url) {
		return;
	}
	try {
		const { text, finalUrl } = await fetchWithLimit(url, SPEC_FETCH_LIMIT_BYTES);
		await finalizeRegistration(ctx, text, { kind: 'url', url: finalUrl });
	} catch (err) {
		void vscode.window.showErrorMessage(`Cannot fetch spec: ${err instanceof Error ? err.message : String(err)}`);
	}
}

export async function registerFromFile(ctx: CommandContext): Promise<void> {
	const picked = await vscode.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		filters: { 'OpenAPI JSON': ['json'] },
		title: 'Select an OpenAPI 3.0.x / 3.1.x JSON document',
	});
	if (!picked || picked.length !== 1) {
		return;
	}
	const fsPath = picked[0].fsPath;
	if (!fsPath.toLowerCase().endsWith('.json')) {
		void vscode.window.showErrorMessage(
			'Only JSON OpenAPI documents are supported; convert YAML documents to JSON and try again.'
		);
		return;
	}
	try {
		const text = await ctx.specLoader.load({ kind: 'file', fsPath });
		await finalizeRegistration(ctx, text, { kind: 'file', fsPath });
	} catch (err) {
		void vscode.window.showErrorMessage(`Cannot read spec: ${err instanceof Error ? err.message : String(err)}`);
	}
}
