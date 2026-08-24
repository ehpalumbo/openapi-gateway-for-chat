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

/**
 * Agent-supplied values for one invocation, mirroring the
 * `gateway_invoke_operation` input schema (R-INV-2).
 */
export interface InvokeInput {
	/** Values for `{name}` placeholders in the path template. */
	pathParams?: Record<string, unknown>;
	/** Query-string values; arrays serialize as repeated keys. */
	queryParams?: Record<string, unknown>;
	/** Extra request headers merged under spec-declared header parameters. */
	headers?: Record<string, unknown>;
	/** JSON body sent when the operation declares a request body. */
	body?: unknown;
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
	const headers = collectHeaders(op, base, pathParams, record(input.headers));
	return finalizeRequest(op.method, url, headers, serializeBody(input.body));
}

/**
 * Verifies every required path parameter has a non-empty value (R-INV-3) and
 * returns the coerced record for downstream substitution.
 */
function requirePathParams(op: OperationInfo, provided: Record<string, unknown>): Record<string, unknown> {
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
	pathParams: Record<string, unknown>,
	queryParams: Record<string, unknown>
): URL {
	let path = substitutePathTemplate(pathTemplate, pathParams);
	if (!path.startsWith('/')) {
		path = `/${path}`;
	}
	const url = new URL(`${base}${path}`);
	url.search = serializeQuery(queryParams);
	return url;
}

function substitutePathTemplate(pathTemplate: string, pathParams: Record<string, unknown>): string {
	return pathTemplate.replace(/\{([^}]+)\}/g, (_, name: string) => encodeURIComponent(stringify(pathParams[name])));
}

/** Serializes query values: scalars as single keys, arrays as repeated keys. */
function serializeQuery(queryParams: Record<string, unknown>): string {
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
	pathParams: Record<string, unknown>,
	userHeaders: Record<string, unknown>
): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const parameter of op.parameters) {
		if (parameter.in === 'header' && hasValue(pathParams[parameter.name])) {
			headers[parameter.name] = stringify(pathParams[parameter.name]);
		}
	}
	for (const [key, value] of Object.entries(userHeaders)) {
		assertHeaderAllowed(key, base);
		if (hasValue(value)) {
			headers[key] = stringify(value);
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

/** Serializes the body as JSON; returns `undefined` when none was supplied. */
function serializeBody(body: unknown): string | undefined {
	return hasValue(body) ? JSON.stringify(body) : undefined;
}

function finalizeRequest(method: string, url: URL, headers: Record<string, string>, body?: string): BuiltRequest {
	const effectiveHeaders = { ...headers };
	if (body !== undefined) {
		effectiveHeaders['Content-Type'] = 'application/json';
	}
	return {
		method: method.toUpperCase(),
		url: url.toString(),
		headers: effectiveHeaders,
		...(body !== undefined ? { body } : {}),
	};
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function hasValue(value: unknown): boolean {
	return value !== undefined && value !== null;
}

/** A required path parameter counts as provided only with a non-empty value. */
function isFilled(value: unknown): boolean {
	return hasValue(value) && !(typeof value === 'string' && value.length === 0);
}

function stringify(value: unknown): string {
	return typeof value === 'string' ? value : String(value);
}

function appendQueryValues(searchParams: URLSearchParams, key: string, value: unknown): void {
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
