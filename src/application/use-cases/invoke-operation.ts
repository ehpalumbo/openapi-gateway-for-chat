import {
	ApiRegistration,
	buildRequest,
	isSupportedImageContentType,
	isTextContentType,
	OperationInfo,
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
	) { }

	/**
	 * Prepares an invocation, checking if user confirmation is required (R-SAFE-1..3).
	 */
	async prepareInvocation(input: InvokeOperationInput): Promise<PrepareInvocationResult> {
		const entry = this.registry.getEntry(input.apiId);
		const operation = entry?.index.get(input.operationId);
		if (!entry || !operation) {
			return { kind: 'not_found' };
		}

		if (SAFE_METHODS.has(operation.method.toUpperCase())) {
			return { kind: 'skip_confirmation' };
		}

		let url: string;
		try {
			url = buildRequest(entry.registration, operation, input).url;
		} catch (error) {
			return {
				kind: 'invalid_invocation',
				error: error instanceof Error ? error.message : String(error),
			};
		}

		const token = await this.tokenStore.getToken(entry.registration.apiId);
		return {
			kind: 'needs_confirmation',
			descriptor: {
				title: `Invoke ${entry.registration.title} — ${operation.operationId}`,
				method: operation.method.toUpperCase(),
				url,
				hasToken: token !== undefined,
				bodyPreview: previewBody(input.body),
			},
		};
	}

	/**
	 * Builds and executes the request for an operation invocation (R-INV-1..5).
	 */
	async execute(
		registration: ApiRegistration,
		operation: OperationInfo,
		input: InvokeOperationInput
	): Promise<OperationExecutionResult> {
		let builtRequest: ReturnType<typeof buildRequest>;
		try {
			builtRequest = buildRequest(registration, operation, input);
		} catch (error) {
			if (error instanceof RequestBuildError) {
				return { kind: 'build', error: error.message };
			}
			throw error;
		}

		const { url, method, headers, body } = builtRequest;
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

function previewBody(body: unknown): string | undefined {
	if (body === undefined || body === null) {
		return undefined;
	}
	let serialized: string;
	try {
		serialized = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
	} catch {
		serialized = String(body);
	}
	return serialized.length > BODY_PREVIEW_LIMIT
		? `${serialized.slice(0, BODY_PREVIEW_LIMIT)}… [truncated ${serialized.length - BODY_PREVIEW_LIMIT} more characters]`
		: serialized;
}
