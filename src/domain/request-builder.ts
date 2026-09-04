/**
 * Pure construction of HTTP requests from an agent's invoke input (R-INV-*).
 *
 * The base URL is strictly the registration's `baseUrl` (R-INV-4): input can
 * only fill path templates, query strings, headers, and the JSON body, all of
 * which are encoded so no value can change the request target's origin.
 * `RequestBuilder` orchestrates the per-concern helpers below; each helper owns
 * one validation or serialization rule so failures point at a single cause.
 */
import { BodyFileReader } from './ports/body-file-reader';
import { ApiRegistration, OperationInfo } from './types';

/** Scalar value accepted for path placeholders; always stringified and URL-encoded. */
export type PathParamValue = string | number | boolean;

/** Scalar or repeated value accepted for query keys; always stringified. `null` is ignored (matches runtime `hasValue` drop). */
export type QueryParamValue = string | number | boolean | null | Array<string | number | boolean | null>;

/** Header values are always strings on the wire. */
export type HeaderValue = string;

/**
 * Agent-supplied values for one invocation, mirroring the
 * `gateway_invoke_operation` input schema (R-INV-2).
 */
export interface InvokeInput {
	/** Values for `{name}` placeholders in the path template. */
	pathParams?: Record<string, PathParamValue>;
	/** Query-string values; arrays serialize as repeated keys. */
	queryParams?: Record<string, QueryParamValue>;
	/** Extra request headers merged under spec-declared header parameters. */
	headers?: Record<string, HeaderValue>;
	/** Request body: JSON object/array (preferred) or raw string sent verbatim. */
	body?: Record<string, unknown> | unknown[] | string;
	/**
	 * Local file path or file:// URI whose bytes are sent as request body;
	 * alternative to 'body'; do not set both; no body validation when using file.
	 */
	bodyFile?: string;
}

/** Lazy supplier for file-backed request bodies (bytes, binary-capable). */
export type BodySupplier = () => Promise<Uint8Array>;

/**
 * A fully built HTTP request ready for execution.
 */
export interface BuiltRequest {
	/** Uppercase HTTP method. */
	method: string;
	/** Absolute URL: registration base URL + substituted path + query string. */
	url: string;
	/** Header names in original case; values stringified. */
	headers: Record<string, string>;
	/** Body: serialized string for inline, supplier for file, undefined when none. */
	body?: string | BodySupplier;
	/** Unified size: inline via Buffer.byteLength, file via stat.size. */
	bodySize?: number;
	/** Original LLM file path when file path used. */
	bodyFile?: string;
}

/**
 * Validation failure raised by {@link RequestBuilder}, with a message written
 * for model retry reasoning (R-INV-3, R-INV-5).
 */
export class RequestBuildError extends Error { }

/** Headers an agent may never set: they would redirect or spoof the target. */
const FORBIDDEN_HEADERS = new Set(['host', 'authorization', 'content-length']);

export class RequestBuilder {
	constructor(private readonly reader: BodyFileReader) { }

	/**
	 * Builds the concrete HTTP request for one operation invocation.
	 *
	 * @param reg - Registration whose `baseUrl` is the sole request target.
	 * @param op - Operation being invoked.
	 * @param input - Agent-supplied parameter and body values.
	 * @throws {@link RequestBuildError} when validation fails.
	 */
	async build(reg: ApiRegistration, op: OperationInfo, input: InvokeInput): Promise<BuiltRequest> {
		const url = this.buildUrl(reg, op, input);
		const headers = this.buildHeaders(reg, op, input);

		this.validateBodyInputs(op, input);
		this.applyContentType(headers, op, input);

		if (hasValue(input.bodyFile)) {
			return this.buildFileRequest(op, url, headers, input.bodyFile);
		}
		return this.buildInlineRequest(op, url, headers, input.body);
	}

	/**
	 * Constructs the absolute URL for the request, substituting path and query values.
	 */
	private buildUrl(reg: ApiRegistration, op: OperationInfo, input: InvokeInput): URL {
		const base = reg.baseUrl.replace(/\/+$/, '');
		const pathParams = requirePathParams(op, record(input.pathParams));
		return buildTargetUrl(base, op.pathTemplate, pathParams, record(input.queryParams));
	}

	/**
	 * Merges spec-declared header parameters with user-supplied headers, rejecting
	 * reserved ones that would redirect or spoof the target (R-INV-4).
	 */
	private buildHeaders(reg: ApiRegistration, op: OperationInfo, input: InvokeInput): Record<string, string> {
		return collectHeaders(op, reg.baseUrl, record(input.headers));
	}

	/** 
	 * Validates body inputs: exclusivity of `body` vs `bodyFile`, and required body presence (R-INV-5). 
	 */
	private validateBodyInputs(op: OperationInfo, input: InvokeInput): void {
		this.assertBodyExclusivity(input);
		this.assertRequiredBody(op, input);
	}

	/**
	 * Throws {@link RequestBuildError} if both `body` and `bodyFile` are provided.
	 */
	private assertBodyExclusivity(input: InvokeInput): void {
		if (hasValue(input.body) && hasValue(input.bodyFile)) {
			throw new RequestBuildError('Provide either "body" or "bodyFile", not both.');
		}
	}

	/**
	 * Throws {@link RequestBuildError} if a required request body is missing.
	 */
	private assertRequiredBody(op: OperationInfo, input: InvokeInput): void {
		if (op.requestBody?.required && !hasValue(input.body) && !hasValue(input.bodyFile)) {
			throw new RequestBuildError(
				`Missing required request body. Provide a non-empty value for the request body of operation ` +
				`"${op.operationId}" (${op.method.toUpperCase()} ${op.pathTemplate}).`
			);
		}
	}

	/**
	 * Applies Content-Type when a body is present and no explicit header exists.
	 * Precedence: explicit header > spec declared first key > file extension / inline inference > fallback.
	 */
	private applyContentType(
		headers: Record<string, string>,
		op: OperationInfo,
		input: InvokeInput,
	): void {
		const hasBody = hasValue(input.body);
		const hasBodyFile = hasValue(input.bodyFile);
		const needsContentType = hasBody || hasBodyFile;
		if (!needsContentType || hasHeader('Content-Type', headers)) {
			return;
		}
		const declared = this.getDeclaredContentType(op);
		if (declared) {
			headers['Content-Type'] = declared;
			return;
		}
		if (hasBodyFile) {
			headers['Content-Type'] = inferFromExtension(input.bodyFile!);
			return;
		}
		if (hasBody) {
			headers['Content-Type'] = resolveContentType(input.body as Record<string, unknown> | unknown[] | string, op) ?? 'application/octet-stream';
		}
	}

	/**
	 * Returns the first declared content type in the spec, or undefined if none.
	 */
	private getDeclaredContentType(op: OperationInfo): string | undefined {
		return op.requestBody?.content ? Object.keys(op.requestBody.content)[0] : undefined;
	}

	/**
	 * Builds a request with a file-backed body, using the {@link BodyFileReader} to stat and read.
	 */
	private async buildFileRequest(
		op: OperationInfo,
		url: URL,
		headers: Record<string, string>,
		bodyFile: string,
	): Promise<BuiltRequest> {
		const fd = await this.reader.stat(bodyFile);
		const body: BodySupplier = () => this.reader.read(bodyFile);
		return {
			method: op.method.toUpperCase(),
			url: url.toString(),
			headers,
			body,
			bodySize: fd.size,
			bodyFile,
		};
	}

	/**
	 * Builds a request with an inline body, serializing JSON or sending strings verbatim.
	 */
	private buildInlineRequest(
		op: OperationInfo,
		url: URL,
		headers: Record<string, string>,
		body: InvokeInput['body'],
	): BuiltRequest {
		const serialized = serializeBody(body);
		const bodySize = serialized !== undefined ? Buffer.byteLength(serialized, 'utf8') : undefined;
		return {
			method: op.method.toUpperCase(),
			url: url.toString(),
			headers,
			...(serialized !== undefined ? { body: serialized } : {}),
			...(bodySize !== undefined ? { bodySize } : {}),
		};
	}
}

/**
 * Verifies every required path parameter has a non-empty value (R-INV-3) and
 * returns the coerced record for downstream substitution.
 */
function requirePathParams(op: OperationInfo, provided: Record<string, PathParamValue>): Record<string, PathParamValue> {
	const missing = op.parameters
		.filter((parameter) => parameter.in === 'path' && !isFilled(provided[parameter.name]))
		.map((parameter) => parameter.name);
	if (missing.length > 0) {
		throw new RequestBuildError(
			`Missing required path parameter(s): ${missing.join(', ')}. ` +
			`Provide a non-empty value for each required path parameter of operation "${op.operationId}" ` +
			`(${op.method.toUpperCase()} ${op.pathTemplate}).`
		);
	}
	return provided;
}

/** Substitutes `{name}` placeholders with URL-encoded values into an absolute URL. */
function buildTargetUrl(
	base: string,
	pathTemplate: string,
	pathParams: Record<string, PathParamValue>,
	queryParams: Record<string, QueryParamValue>
): URL {
	let path = substitutePathTemplate(pathTemplate, pathParams);
	if (!path.startsWith('/')) {
		path = `/${path}`;
	}
	const url = new URL(`${base}${path}`);
	url.search = serializeQuery(queryParams);
	return url;
}

function substitutePathTemplate(pathTemplate: string, pathParams: Record<string, PathParamValue>): string {
	return pathTemplate.replace(/\{([^}]+)\}/g, (_, name: string) => encodeURIComponent(stringify(pathParams[name] as PathParamValue)));
}

/** Serializes query values: scalars as single keys, arrays as repeated keys. */
function serializeQuery(queryParams: Record<string, QueryParamValue>): string {
	const searchParams = new URLSearchParams();
	for (const [key, value] of Object.entries(queryParams)) {
		appendQueryValues(searchParams, key, value);
	}
	return searchParams.toString();
}

/**
 * Merges spec-declared header parameters with user-supplied headers, rejecting
 * reserved ones that would redirect or spoof the target (R-INV-4).
 */
function collectHeaders(
	op: OperationInfo,
	base: string,
	userHeaders: Record<string, HeaderValue>
): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(userHeaders)) {
		assertHeaderAllowed(key, base);
		if (hasValue(value)) {
			headers[key] = stringify(value);
		}
	}
	if (op.parameters) {
		for (const parameter of op.parameters) {
			if (parameter.in === 'header' && parameter.required && !hasHeader(parameter.name, headers)) {
				throw new RequestBuildError(
					`Missing required header parameter "${parameter.name}". ` +
					`Provide a non-empty value for each required header parameter of operation "${op.operationId}" ` +
					`(${op.method.toUpperCase()} ${op.pathTemplate}).`
				);
			}
		}
	}
	return headers;
}

function assertHeaderAllowed(key: string, base: string): void {
	if (FORBIDDEN_HEADERS.has(key.toLowerCase())) {
		throw new RequestBuildError(
			`The "${key}" header cannot be set by the caller. Requests always target the registered base URL ` +
			`${base}; authentication is attached automatically when a token is stored.`
		);
	}
}

/** Serializes the body as JSON; strings are sent verbatim, returns `undefined` when none was supplied. */
function serializeBody(body: Record<string, unknown> | unknown[] | string | undefined): string | undefined {
	if (!hasValue(body)) {
		return undefined;
	}
	if (typeof body === 'string') {
		return body;
	}
	return JSON.stringify(body);
}

function hasHeader(name: string, headers: Record<string, string>): boolean {
	const lower = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function resolveContentType(
	body: Record<string, unknown> | unknown[] | string,
	op: OperationInfo,
): string | undefined {
	if (typeof body === 'string') {
		const declared = op.requestBody?.content ? Object.keys(op.requestBody.content)[0] : undefined;
		if (declared) {
			return declared;
		}
		const trimmed = body.trim();
		if (
			(trimmed.startsWith('{') && trimmed.endsWith('}')) ||
			(trimmed.startsWith('[') && trimmed.endsWith(']'))
		) {
			try {
				JSON.parse(trimmed);
				return 'application/json';
			} catch {
				// not valid JSON — fall through to text/plain
			}
		}
		return 'text/plain';
	}
	return 'application/json';
}

/**
 * Infers a MIME type from the file extension of a path or file:// URI.
 * Returns 'application/octet-stream' when no extension is present or recognized.
 */
function inferFromExtension(filePath: string): string {
	// Strip file:// prefix if present for extension detection.
	let normalized = filePath;
	if (normalized.startsWith('file://')) {
		try {
			normalized = decodeURIComponent(new URL(normalized).pathname);
		} catch {
			normalized = normalized.replace(/^file:\/\//, '');
		}
	}
	const lastSlash = normalized.lastIndexOf('/');
	const lastDot = normalized.lastIndexOf('.');
	if (lastDot === -1 || lastDot < lastSlash) {
		return 'application/octet-stream';
	}
	const ext = normalized.slice(lastDot + 1).toLowerCase();
	switch (ext) {
		case 'json':
			return 'application/json';
		case 'txt':
			return 'text/plain';
		case 'xml':
			return 'application/xml';
		case 'html':
		case 'htm':
			return 'text/html';
		default:
			return 'application/octet-stream';
	}
}

function record<T>(value: Record<string, T> | undefined): Record<string, T> {
	return typeof value === 'object' && value !== null ? (value as Record<string, T>) : {} as Record<string, T>;
}

function hasValue(value: unknown): value is NonNullable<unknown> {
	return value !== undefined && value !== null;
}

/** A required path parameter counts as provided only with a non-empty value. */
function isFilled(value: unknown): boolean {
	return hasValue(value) && !(typeof value === 'string' && value.length === 0);
}

function stringify(value: string | number | boolean): string {
	return typeof value === 'string' ? value : String(value);
}

function appendQueryValues(searchParams: URLSearchParams, key: string, value: QueryParamValue): void {
	if (!hasValue(value)) {
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			if (hasValue(item)) {
				searchParams.append(key, stringify(item));
			}
		}
		return;
	}
	searchParams.append(key, stringify(value));
}
