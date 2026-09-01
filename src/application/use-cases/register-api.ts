import {
	ApiIndexEntry,
	ApiRegistration,
	ApiSnapshot,
	API_ID_VALIDATION_MESSAGE,
	buildApiModel,
	isValidApiId,
	OpenApiDocument,
	parseSpec,
	SpecSource,
} from '../../domain';
import { ApiRegistry, InsertResult, TokenStore } from '../ports';

/**
 * Parses spec text into a last-good snapshot: the grouped operation model
 * (R-REG-7). The raw document is discarded — refresh rebuilds from
 * {@link SpecSource} (R-REG-6).
 *
 * @param jsonText - Raw OpenAPI JSON text.
 * @returns The snapshot ready to store in a registration.
 */
export function buildSnapshot(jsonText: string): ApiSnapshot {
	const document = parseSpec(jsonText);
	return { model: buildApiModel(document) };
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
	const { title, version } = snapshot.model.info;
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
 * Builds the lightweight memento index entry for a registration.
 */
export function toIndexEntry(registration: ApiRegistration): ApiIndexEntry {
	return {
		apiId: registration.apiId,
		title: registration.title,
		version: registration.version,
		baseUrl: registration.baseUrl,
		source: registration.source,
		description: registration.snapshot.model.info.description,
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
	async execute(params: RegisterApiParams): Promise<InsertResult & { registration?: ApiRegistration }> {
		if (!isValidApiId(params.apiId)) {
			throw new Error(`Invalid apiId "${params.apiId}": ${API_ID_VALIDATION_MESSAGE}`);
		}
		const registration = createRegistration(params.jsonText, params.apiId, params.baseUrl, params.source);
		const result = await this.registry.insert(registration);
		if (result.status === 'conflict') {
			return result;
		}

		if (params.token) {
			await this.tokenStore.setToken(params.apiId, params.token);
		}

		return { status: 'created', registration };
	}
}
