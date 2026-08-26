/**
 * Pure construction of HTTP requests from an agent's invoke input (R-INV-*).
 *
 * The base URL is strictly the registration's `baseUrl` (R-INV-4): input can
 * only fill path templates, query strings, headers, and the JSON body, all of
 * which are encoded so no value can change the request target's origin.
 * `buildRequest` orchestrates the per-concern helpers below; each helper owns
 * one validation or serialization rule so failures point at a single cause.
 */
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
}

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
	/** JSON-serialized body, present only when the caller supplied one. */
	body?: string;
}

/**
 * Validation failure raised by {@link buildRequest}, with a message written
 * for model retry reasoning (R-INV-3, R-INV-5).
 */
export class RequestBuildError extends Error { }

/** Headers an agent may never set: they would redirect or spoof the target. */
const FORBIDDEN_HEADERS = new Set(['host', 'authorization', 'content-length']);

/**
 * Builds the concrete HTTP request for one operation invocation.
 *
 * @param reg - Registration whose `baseUrl` is the sole request target.
 * @param op - Operation being invoked.
 * @param input - Agent-supplied parameter and body values.
 * @throws {@link RequestBuildError} when required path parameters are missing
 *         or forbidden headers are attempted.
 */
export function buildRequest(reg: ApiRegistration, op: OperationInfo, input: InvokeInput): BuiltRequest {
	const base = reg.baseUrl.replace(/\/+$/, '');
	const pathParams = requirePathParams(op, record(input.pathParams));
	const url = buildTargetUrl(base, op.pathTemplate, pathParams, record(input.queryParams));
	const headers = collectHeaders(op, base, record(input.headers));
	if (op.requestBody && op.requestBody.required && !input.body) {
		throw new RequestBuildError(
			`Missing required request body. Provide a non-empty value for the request body of operation ` +
			`"${op.operationId}" (${op.method.toUpperCase()} ${op.pathTemplate}).`
		);
	}
	if (hasValue(input.body) && !hasHeader('Content-Type', headers)) {
		const contentType = resolveContentType(input.body, op);
		if (contentType) {
			headers['Content-Type'] = contentType;
		}
	}
	const body = serializeBody(input.body);
	return {
		method: op.method.toUpperCase(),
		url: url.toString(),
		headers,
		...(body !== undefined ? { body } : {}),
	};
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
