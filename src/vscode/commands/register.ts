/**
 * Registration commands (R-REG-1, R-REG-2) and the shared wizard they drive:
 * spec text → unique `apiId` → confirmed base URL (R-REG-9) → optional
 * Bearer token → registry upsert.
 */
import * as vscode from 'vscode';
import { parseSpec } from '../../core/openapi';
import { OpenApiDocument, SpecSource } from '../../core/types';
import { fetchWithLimit } from '../http';
import {
	CommandContext,
	SPEC_FETCH_LIMIT_BYTES,
	createRegistration,
	loadSpecFromSource,
	resolveBaseUrlSuggestion,
	slugifyTitle,
} from './common';

async function promptForUniqueId(ctx: CommandContext, suggested: string): Promise<string | undefined> {
	let candidate = suggested;
	for (; ;) {
		const entered = await vscode.window.showInputBox({
			prompt: 'Unique API identifier (used by tools to reference this API)',
			value: candidate,
			validateInput: (value) =>
				value.trim().length === 0
					? 'Enter a non-empty identifier.'
					: undefined,
		});
		if (entered === undefined) {
			return undefined;
		}
		const apiId = entered.trim();
		const existing = ctx.registry.get(apiId);
		if (!existing) {
			return apiId;
		}
		void vscode.window.showErrorMessage(`An API "${apiId}" (${existing.title}) is already registered. Choose a different identifier.`);
		candidate = apiId;
	}
}

/**
 * Always shows an editable confirmation prompt pre-filled with the suggested
 * base URL, so specs carrying placeholder URIs can be corrected (R-REG-9).
 * When several servers are declared, a QuickPick first selects which one to
 * suggest.
 */
async function promptForBaseUrl(doc: OpenApiDocument): Promise<string | undefined> {
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
				return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? undefined : 'Base URL must be http(s).';
			} catch {
				return 'Enter an absolute http(s) URL.';
			}
		},
	});
}

/**
 * Prompts for an optional Bearer token to send with invocations, stored
 * securely in the workspace's secret store.
 */
async function promptForBearerToken(): Promise<string | undefined> {
	return vscode.window.showInputBox({
		prompt: 'Bearer token to send with invocations (optional, stored securely)',
		password: true,
	});
}

async function finalizeRegistration(ctx: CommandContext, jsonText: string, source: SpecSource): Promise<void> {
	let doc: OpenApiDocument;
	try {
		doc = parseSpec(jsonText);
	} catch (err) {
		void vscode.window.showErrorMessage(`Cannot register API: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	const apiId = await promptForUniqueId(ctx, slugifyTitle(doc.info.title));
	if (!apiId) {
		return;
	}

	const baseUrl = await promptForBaseUrl(doc);
	if (!baseUrl) {
		return;
	}

	const token = await promptForBearerToken();
	if (token) {
		await ctx.tokens.setToken(apiId, token);
	}

	const registration = createRegistration(jsonText, apiId, baseUrl, source);
	const result = ctx.registry.upsert(registration);
	if (result.status === 'conflict') {
		void vscode.window.showErrorMessage(`An API "${apiId}" (${result.existingTitle}) is already registered.`);
		return;
	}
	ctx.onChange();
	const operationsCount = registration.snapshot.model.groups.flatMap((group) => group.operations).length;
	void vscode.window.showInformationMessage(
		`Registered API "${doc.info.title}" as "${apiId}" with ${operationsCount} operations.`
	);
}

/**
 * Handler for R-REG-1: prompts for a spec URL, fetches it, and drives the
 * registration wizard.
 */
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

/**
 * Handler for R-REG-2: picks an OpenAPI JSON file from the workspace and
 * drives the registration wizard.
 */
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
		void vscode.window.showErrorMessage('Only JSON OpenAPI documents are supported; convert YAML documents to JSON and try again.');
		return;
	}
	try {
		const text = await loadSpecFromSource({ kind: 'file', fsPath });
		await finalizeRegistration(ctx, text, { kind: 'file', fsPath });
	} catch (err) {
		void vscode.window.showErrorMessage(`Cannot read spec: ${err instanceof Error ? err.message : String(err)}`);
	}
}
