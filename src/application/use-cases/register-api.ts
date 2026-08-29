import {
	ApiRegistration,
	ApiSnapshot,
	buildApiModel,
	OpenApiDocument,
	parseSpec,
	SpecSource,
} from '../../domain';
import { ApiRegistry, TokenStore, UpsertResult } from '../ports';

/**
 * Parses spec text into a last-good snapshot: validated document plus its
 * grouped operation model (R-REG-7).
 *
 * @param jsonText - Raw OpenAPI JSON text.
 * @returns The snapshot ready to store in a registration.
 */
export function buildSnapshot(jsonText: string): ApiSnapshot {
	const document = parseSpec(jsonText);
	return { document, model: buildApiModel(document) };
}

/**
 * Parses spec text into a fully built {@link ApiRegistration}.
 */
export function createRegistration(
	jsonText: string,
	apiId: string,
	baseUrl: string,
	source: SpecSource
): ApiRegistration {
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
 * Reduces an `info.title` to a slug used as the suggested `apiId`.
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
 * Derives the base-URL suggestion shown pre-filled in confirmation prompts (R-REG-9).
 */
export function resolveBaseUrlSuggestion(doc: OpenApiDocument): string {
	const firstServer = doc.servers?.find((server) => typeof server.url === 'string' && server.url.length > 0);
	return firstServer ? firstServer.url : FALLBACK_BASE_URL;
}

export interface RegisterApiParams {
	jsonText: string;
	apiId: string;
	baseUrl: string;
	source: SpecSource;
	token?: string;
}

export class RegisterApiUseCase {
	constructor(
		private readonly registry: ApiRegistry,
		private readonly tokenStore: TokenStore
	) { }

	/**
	 * Registers an API from spec text, validated against the registry and persists credentials.
	 */
	async execute(params: RegisterApiParams): Promise<UpsertResult & { registration?: ApiRegistration }> {
		const registration = createRegistration(params.jsonText, params.apiId, params.baseUrl, params.source);
		const result = this.registry.upsert(registration);
		if (result.status === 'conflict') {
			return result;
		}

		if (params.token) {
			await this.tokenStore.setToken(params.apiId, params.token);
		}

		return { status: 'created', registration };
	}
}
