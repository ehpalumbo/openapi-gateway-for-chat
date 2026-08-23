/**
 * Shared building blocks for the gateway commands: the dependency context,
 * spec loading/parsing helpers, and pure suggestion logic.
 *
 * These are exported so integration tests can exercise registration and
 * refresh flows directly, without driving VS Code UI.
 */
import * as vscode from 'vscode';
import { parseSpec } from '../../core/openapi';
import { buildApiModel } from '../../core/operations';
import { ApiRegistration, ApiSnapshot, OpenApiDocument, SpecSource } from '../../core/types';
import { ApiRegistry } from '../../store/registry';
import { TokenStore } from '../../store/secrets';
import { fetchWithLimit } from '../http';

/**
 * Dependencies shared by all command handlers and the activation refresh.
 */
export interface CommandContext {
	registry: ApiRegistry;
	tokens: TokenStore;
	/** Invoked after every mutation so tools re-register (Phase 3). */
	onChange: () => void;
}

/** Byte cap for spec fetching; response size limits are handled separately in Phase 5. */
export const SPEC_FETCH_LIMIT_BYTES = 10 * 1024 * 1024;

/**
 * Parses spec text into a last-good snapshot: validated document plus its
 * grouped operation model. Shared by registration and refresh so both paths
 * build snapshots identically.
 *
 * @param jsonText - Raw OpenAPI JSON text from a fetch or file read.
 * @returns The snapshot ready to store in a registration.
 * @throws {SpecError} When the document is not a supported OpenAPI JSON document.
 */
export function buildSnapshot(jsonText: string): ApiSnapshot {
	const document = parseSpec(jsonText);
	return { document, model: buildApiModel(document) };
}

/**
 * Parses spec text into a fully built {@link ApiRegistration}.
 *
 * @param jsonText - Raw OpenAPI JSON text from a fetch or file read.
 * @param apiId - Unique user-chosen identifier.
 * @param baseUrl - Server URL selected for invocation (R-REG-9).
 * @param source - Origin of the spec so refresh can re-load it.
 * @returns The registration with its last-good snapshot.
 * @throws {SpecError} When the document is not a supported OpenAPI JSON document.
 */
export function createRegistration(jsonText: string, apiId: string, baseUrl: string, source: SpecSource): ApiRegistration {
	const snapshot = buildSnapshot(jsonText);
	const { title, version } = snapshot.document.info;
	return {
		apiId,
		title,
		version,
		baseUrl,
		source,
		snapshot,
	};
}

/**
 * Loads the raw spec text for a registration's origin: fetches URLs with the
 * byte cap or reads workspace files.
 *
 * @param source - Where the spec came from at registration time.
 * @returns The raw document text.
 */
export async function loadSpecFromSource(source: SpecSource): Promise<string> {
	if (source.kind === 'url') {
		return (await fetchWithLimit(source.url, SPEC_FETCH_LIMIT_BYTES)).text;
	}
	const fileData = await vscode.workspace.fs.readFile(vscode.Uri.file(source.fsPath));
	return Buffer.from(fileData).toString('utf8');
}

/**
 * Reduces an `info.title` to a slug used as the suggested `apiId`.
 *
 * @param title - API title from the spec.
 */
export function slugifyTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** Suggested when the spec declares no servers at all. */
const FALLBACK_BASE_URL = 'https://api.example.com/v1';

/**
 * Derives the base-URL suggestion shown pre-filled in the confirmation prompt
 * (R-REG-9). The first declared server wins; specs often ship placeholder URIs,
 * which is why the user always gets to override the value afterwards.
 *
 * @param doc - Parsed OpenAPI document being registered.
 * @returns A base URL to pre-fill the confirmation prompt with.
 */
export function resolveBaseUrlSuggestion(doc: OpenApiDocument): string {
	const firstServer = doc.servers?.find((server) => typeof server.url === 'string' && server.url.length > 0);
	return firstServer ? firstServer.url : FALLBACK_BASE_URL;
}
