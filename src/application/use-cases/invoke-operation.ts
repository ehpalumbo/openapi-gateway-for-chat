import {
	ApiRegistration,
	BuiltRequest,
	isSupportedImageContentType,
	isTextContentType,
	OperationInfo,
	RequestBuilder,
	RequestBuildError,
} from '../../domain';
import { InvokeOperationInput } from '../dtos/invoke-input';
import { ApiRegistry, HttpClient, RawHttpResponse, TokenStore } from '../ports';

/** Milliseconds before an in-flight HTTP request is aborted. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Methods that never mutate state and therefore skip confirmation (R-SAFE-1). */
export const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * The classified body of a successful HTTP response, resolved by content type (R-RESP-3).
 */
export type ResponseBodyContent =
	| { class: 'text'; text: string }
	| { class: 'image'; bytes: Uint8Array; mimeType: string }
	| { class: 'binary'; bytes: Uint8Array; mimeType: string };

/**
 * A completed HTTP call carrying status, headers, and classified body.
 */
export interface HttpResponsePayload {
	kind: 'response';
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body?: ResponseBodyContent;
	url: string;
}

/** A transport failure — the request never produced an HTTP response. */
export interface NetworkErrorPayload {
	kind: 'network';
	message: string;
	url: string;
}

/** A request that failed validation before any network traffic (R-INV-3). */
export interface RequestBuildFailure {
	kind: 'build';
	error: string;
}

/** The outcome of {@link InvokeOperationUseCase.execute}: exactly one of each failure mode. */
export type OperationExecutionResult = HttpResponsePayload | NetworkErrorPayload | RequestBuildFailure;

/** Information needed to render a user safety confirmation prompt (R-SAFE-*). */
export interface ConfirmationDescriptor {
	title: string;
	method: string;
	url: string;
	hasToken: boolean;
	bodyPreview?: string;
	bodyFile?: string;
	bodySize?: number;
}

export type PrepareInvocationResult =
	| { kind: 'skip_confirmation' }
	| { kind: 'needs_confirmation'; descriptor: ConfirmationDescriptor }
	| { kind: 'invalid_invocation'; error: string }
	| { kind: 'not_found' };

export class InvokeOperationUseCase {
	constructor(
		private readonly registry: ApiRegistry,
		private readonly tokenStore: TokenStore,
		private readonly httpClient: HttpClient,
		private readonly requestBuilder: RequestBuilder,
	) { }

	/**
	 * Prepares an invocation, checking if user confirmation is required (R-SAFE-1..3).
	 */
	async prepareInvocation(input: InvokeOperationInput): Promise<PrepareInvocationResult> {
		const entry = await this.registry.getEntry(input.apiId);
		const operation = entry?.index.get(input.operationId);
		if (!entry || !operation) {
			return { kind: 'not_found' };
		}

		let built: BuiltRequest;
		try {
			built = await this.requestBuilder.build(entry.registration, operation, input);
		} catch (error) {
			if (error instanceof RequestBuildError) {
				return {
					kind: 'invalid_invocation',
					error: error instanceof Error ? error.message : String(error),
				};
			}
			throw error;
		}

		if (SAFE_METHODS.has(built.method)) {
			return { kind: 'skip_confirmation' };
		}

		const token = await this.tokenStore.getToken(entry.registration.apiId);
		return {
			kind: 'needs_confirmation',
			descriptor: {
				title: `Invoke ${entry.registration.title} — ${operation.operationId}`,
				method: built.method,
				url: built.url,
				hasToken: token !== undefined,
				bodyPreview: typeof built.body === 'string' ? previewBody(built.body) : undefined,
				bodyFile: built.bodyFile,
				bodySize: built.bodySize,
			},
		};
	}

	/**
	 * Builds, resolves the body bytes, and executes the request (R-INV-1..5).
	 * File bodies are resolved here (not in the HTTP client) so read failures
	 * surface as `build` errors before any network traffic.
	 */
	async execute(
		registration: ApiRegistration,
		operation: OperationInfo,
		input: InvokeOperationInput
	): Promise<OperationExecutionResult> {
		let built: BuiltRequest;
		try {
			built = await this.requestBuilder.build(registration, operation, input);
		} catch (error) {
			if (error instanceof RequestBuildError) {
				return { kind: 'build', error: error.message };
			}
			throw error;
		}

		let body: string | Uint8Array | undefined;
		try {
			body = await resolveRequestBody(built.body);
		} catch (error) {
			if (error instanceof RequestBuildError) {
				return { kind: 'build', error: error.message };
			}
			throw error;
		}

		const { url, method, headers } = built;
		const token = await this.tokenStore.getToken(registration.apiId);
		if (token !== undefined) {
			headers.Authorization = `Bearer ${token}`;
		}

		try {
			const rawResponse = await this.httpClient.send({
				method,
				url,
				headers,
				body,
				timeoutMs: REQUEST_TIMEOUT_MS,
			});
			return toPayload(url, rawResponse);
		} catch (error) {
			return {
				kind: 'network',
				message:
					`Network request failed: ${error instanceof Error ? error.message : String(error)}. ` +
					'The registered API may be unreachable; check connectivity or the registration.',
				url,
			};
		}
	}
}

/**
 * Resolves the request body, which may be a string, bytes, or a function returning either.
 * If the body is a function, it is invoked and awaited to get the actual body content.
 */
async function resolveRequestBody(body: BuiltRequest['body']): Promise<string | Uint8Array | undefined> {
	if (typeof body === 'function') {
		return await body();
	}
	return body;
}

/**
 * Converts a raw HTTP response to a classified {@link HttpResponsePayload}.
 */
function toPayload(url: string, response: RawHttpResponse): HttpResponsePayload {
	const body = classifyBody(response.headers, response.body);
	return {
		kind: 'response',
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
		body,
		url,
	};
}

/**
 * Classifies the response body based on content type and returns a structured representation.
 * If the body is empty, returns undefined.
 */
function classifyBody(headers: Record<string, string>, bytes: Uint8Array): ResponseBodyContent | undefined {
	if (bytes.length === 0) {
		return undefined;
	}
	const mimeType = headers['content-type'] as string | undefined;
	const baseMimeType = (mimeType?.split(';')[0] ?? 'application/octet-stream').trim().toLowerCase();
	if (isSupportedImageContentType(baseMimeType)) {
		return { class: 'image', bytes, mimeType: baseMimeType };
	}
	if (isTextContentType(baseMimeType)) {
		return { class: 'text', text: new TextDecoder().decode(bytes) };
	}
	return { class: 'binary', bytes, mimeType: baseMimeType };
}

const BODY_PREVIEW_LIMIT = 600;

/**
 * Returns a preview of the body string, truncated if it exceeds the limit.
 * If the body is undefined or null, returns undefined.
 */
function previewBody(body: string): string | undefined {
	if (body === undefined || body === null) {
		return undefined;
	}
	let serialized: string;
	try {
		const trimmed = body.trim();
		if (
			(trimmed.startsWith('{') && trimmed.endsWith('}')) ||
			(trimmed.startsWith('[') && trimmed.endsWith(']'))
		) {
			try {
				const parsed = JSON.parse(trimmed);
				serialized = JSON.stringify(parsed, null, 2);
			} catch {
				serialized = body;
			}
		} else {
			serialized = body;
		}
	} catch {
		serialized = String(body);
	}
	return serialized.length > BODY_PREVIEW_LIMIT
		? `${serialized.slice(0, BODY_PREVIEW_LIMIT)}… [truncated ${serialized.length - BODY_PREVIEW_LIMIT} more characters]`
		: serialized;
}
