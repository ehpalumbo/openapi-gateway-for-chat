/**
 * The `gateway_invoke_operation` tool (R-INV-*): builds and executes HTTP
 * requests against a registered base URL with Bearer-token injection and
 * native safety confirmation (R-SAFE-*).
 *
 * Errors — network failure, non-2xx responses, builder validation — are
 * returned as structured results instead of throwing so the model can reason
 * about retry or correction (R-INV-5). Every response carrying an HTTP status
 * is served as a metadata text part with the raw HTTP head (bare status line,
 * headers in arrival order, blank line — e.g. `200 OK\ncontent-type:
 * application/json\n\n`) that is always present (R-RESP-1), followed — only
 * when the response has a body — by the body routed by content type
 * (R-RESP-3): textual ones as a text part with the UTF-8 body, vision-safe
 * images as an image `LanguageModelDataPart`, and non-image binaries spilled
 * to disk under `<storageUri>/response-spills/` with a text part referencing
 * the absolute path — Copilot only forwards text parts and image data parts
 * from tool results into the model prompt (see microsoft/vscode#275300).
 * Responses without a body (e.g. `204`, empty `404`) return only the metadata
 * part. Only failures without a status — network errors — fall back to a plain
 * single-text result.
 *
 * The host validates `options.input` against the `inputSchema` declared in
 * package.json before dispatching (`vscode.d.ts:21166`), so inputs are
 * consumed directly without runtime coercion.
 */
import * as vscode from 'vscode';
import { buildRequest, HeaderValue, PathParamValue, QueryParamValue, RequestBuildError } from '../../core/request-builder';
import { buildSpillFileName, isSupportedImageContentType, isTextContentType } from '../../core/response-handler';
import { OperationInfo } from '../../core/types';
import { RegistryEntry } from '../../store/registry';
import { randomToken } from '../spills';
import { errorResult, isFailure, resolveEntry, textResult } from './common';
import { ToolContext } from './context';

/** Methods that never mutate state and therefore skip confirmation (R-SAFE-1). */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

/** Milliseconds before an in-flight HTTP request is aborted. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Characters of a request/response body shown before truncation. */
const BODY_PREVIEW_LIMIT = 600;
const EXCERPT_LIMIT = 1000;

/** MIME type assumed when the server does not declare one. */
const DEFAULT_MIME_TYPE = 'application/octet-stream';

/**
 * The input shape for the `gateway_invoke_operation` tool. The host validates
 * `options.input` against the `inputSchema` declared in package.json before
 * dispatching, so handlers can consume `options.input` directly.
 */
export interface InvokeOperationInput {
	apiId: string;
	operationId: string;
	pathParams?: Record<string, PathParamValue>;
	queryParams?: Record<string, QueryParamValue>;
	headers?: Record<string, HeaderValue>;
	body?: Record<string, unknown> | unknown[] | string;
}

/** An operation resolved together with its registration's runtime view. */
interface ResolvedOperation {
	entry: RegistryEntry;
	operation: OperationInfo;
}

/**
 * Creates the `gateway_invoke_operation` tool, which builds and executes an
 * HTTP request against a registered base URL with Bearer-token injection and
 * native safety confirmation (R-SAFE-*).
 */
export function createInvokeOperationTool(context: ToolContext): vscode.LanguageModelTool<InvokeOperationInput> {
	return {
		prepareInvocation: ({ input }) => prepareInvocation(context, input),
		invoke: ({ input }) => invokeOperation(context, input),
	};
}

async function prepareInvocation(
	context: ToolContext,
	input: InvokeOperationInput
): Promise<vscode.PreparedToolInvocation | undefined> {
	const resolved = resolveSilently(context.registry, input);
	if (!resolved || !shouldConfirm(resolved.operation)) {
		return undefined;
	}
	return buildConfirmation(resolved.entry, resolved.operation, input, context);
}

function resolveSilently(
	registry: ToolContext['registry'],
	input: InvokeOperationInput
): ResolvedOperation | undefined {
	if (registry.list().length === 0) {
		return undefined;
	}
	const entry = registry.getEntry(input.apiId);
	const operation = entry?.index.get(input.operationId);
	if (!entry || !operation) {
		return undefined;
	}
	return { entry, operation };
}

function shouldConfirm(operation: OperationInfo): boolean {
	return !SAFE_METHODS.has(operation.method.toUpperCase());
}

/**
 * Builds the rich confirmation content: HTTP method, resolved URL, headers
 * with `Authorization` redacted, and a truncated body preview (R-SAFE-3).
 */
async function buildConfirmation(
	entry: RegistryEntry,
	operation: OperationInfo,
	input: InvokeOperationInput,
	context: ToolContext
): Promise<vscode.PreparedToolInvocation> {
	let url: string;
	try {
		url = buildRequest(entry.registration, operation, input).url;
	} catch (error) {
		return {
			invocationMessage: new vscode.MarkdownString(
				`OpenAPI Gateway: invalid invocation — ${error instanceof Error ? error.message : String(error)}`
			),
		};
	}
	const hasToken = (await context.tokens.getToken(entry.registration.apiId)) !== undefined;
	return {
		confirmationMessages: {
			title: `Invoke ${entry.registration.title} — ${operation.operationId}`,
			message: renderConfirmationMarkdown(operation.method.toUpperCase(), url, hasToken, previewBody(input.body)),
		},
	};
}

function renderConfirmationMarkdown(
	method: string,
	url: string,
	hasToken: boolean,
	bodyPreview: string | undefined
): vscode.MarkdownString {
	const lines = [
		`**${method}** ${url}`,
		'',
		'Headers:',
		'- Accept: application/json',
		hasToken ? '- Authorization: Bearer ***' : undefined,
	].filter((line): line is string => line !== undefined);
	if (bodyPreview !== undefined) {
		lines.push('', 'Body:', '```json', bodyPreview, '```');
	}
	const message = new vscode.MarkdownString(lines.join('\n'));
	message.isTrusted = false;
	return message;
}

async function invokeOperation(
	context: ToolContext,
	input: InvokeOperationInput
): Promise<vscode.LanguageModelToolResult> {
	const found = resolveEntry(context.registry, input.apiId);
	if (isFailure(found)) {
		return found;
	}
	const operation = found.index.get(input.operationId);
	if (!operation) {
		const available = [...found.index.keys()].join(', ');
		return errorResult(`Unknown operationId "${input.operationId}". Available operations: ${available}.`);
	}
	return executeOperation(found, operation, input, context);
}

/**
 * Builds the request, attaches authentication, performs the call, and maps
 * every failure mode onto a structured result payload.
 */
async function executeOperation(
	entry: RegistryEntry,
	operation: OperationInfo,
	input: InvokeOperationInput,
	context: ToolContext
): Promise<vscode.LanguageModelToolResult> {
	let request;
	try {
		request = buildRequest(entry.registration, operation, input);
	} catch (error) {
		if (error instanceof RequestBuildError) {
			return textResult({ error: error.message, method: operation.method.toUpperCase(), operationId: operation.operationId });
		}
		throw error;
	}

	await attachAuthorization(request.headers, context, entry.registration.apiId);

	let response: Response;
	try {
		response = await performRequest(request);
	} catch (error) {
		return textResult(
			structuredError(
				`Network request failed: ${error instanceof Error ? error.message : String(error)}. ` +
				'The registered API may be unreachable; check connectivity or the registration.',
				request.url
			)
		);
	}
	return serveResponse(entry, operation, response, context);
}

/**
 * Serves any response that carries an HTTP status as a metadata text part
 * first (raw HTTP head: bare status line, headers, blank line — R-RESP-1,
 * always present), then — only when the response has a body — the body routed
 * by content type (R-RESP-3). When the body is empty (strict `byteLength===0`,
 * e.g. `204`, empty `404`) only the metadata part is returned. Non-2xx
 * statuses are not special-cased — the model reads the status from the
 * metadata part.
 */
async function serveResponse(
	entry: RegistryEntry,
	operation: OperationInfo,
	response: Response,
	context: ToolContext
): Promise<vscode.LanguageModelToolResult> {
	const headers = headersToRecord(response.headers);
	const statusLine = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
	const bytes = new Uint8Array(await response.arrayBuffer());
	const metadataPart = new vscode.LanguageModelTextPart(formatResponseHead(statusLine, headers));

	if (bytes.length === 0) {
		return new vscode.LanguageModelToolResult([metadataPart]);
	}

	const mimeType = headers['content-type'] ?? DEFAULT_MIME_TYPE;
	const baseMimeType = mimeType.split(';')[0].trim().toLowerCase();
	if (isSupportedImageContentType(baseMimeType)) {
		return new vscode.LanguageModelToolResult([metadataPart, new vscode.LanguageModelDataPart(bytes, baseMimeType)]);
	}
	if (isTextContentType(baseMimeType)) {
		return new vscode.LanguageModelToolResult([metadataPart, new vscode.LanguageModelTextPart(new TextDecoder().decode(bytes))]);
	}
	return new vscode.LanguageModelToolResult([metadataPart, await spillBody(entry, operation, mimeType, bytes, context)]);
}

/**
 * Writes a non-image binary body to the spill directory and renders it as a
 * text part referencing the absolute path plus content type and byte size —
 * Copilot drops non-image data parts from tool results (R-RESP-3).
 */
async function spillBody(
	entry: RegistryEntry,
	operation: OperationInfo,
	mimeType: string,
	bytes: Uint8Array,
	context: ToolContext
): Promise<vscode.LanguageModelTextPart> {
	const fileName = buildSpillFileName(`${entry.registration.apiId}-${operation.operationId}`, mimeType, randomToken);
	const filePath = await context.spills.write(fileName, bytes);
	return new vscode.LanguageModelTextPart(renderSpillNotice(mimeType, bytes.byteLength, filePath));
}

/**
 * Renders the spill reference as plain text framed as a gateway notice so a
 * model cannot mistake it for actual API response content (R-RESP-3).
 */
function renderSpillNotice(mimeType: string, byteSize: number, filePath: string): string {
	return (
		'[gateway notice, not API response content]\n' +
		`The response body was a non-image binary (${mimeType}; ${byteSize} bytes) that could not be rendered as text. It was saved to:\n` +
		`${filePath}\n` +
		'Use shell tools or open the file directly.'
	);
}

/** Flattens a fetch `Headers` bag into a plain record for tool output. */
function headersToRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	headers.forEach((value, key) => {
		record[key] = value;
	});
	return record;
}

/**
 * Formats the metadata head as plain text mirroring the raw HTTP response:
 * bare status line, headers in arrival order (lower-case as returned by
 * fetch()), then a blank line. Example: `200 OK\ncontent-type: application/json\n\n`.
 */
function formatResponseHead(statusLine: string, headers: Record<string, string>): string {
	const lines = [statusLine];
	for (const [key, value] of Object.entries(headers)) {
		lines.push(`${key}: ${value}`);
	}
	return lines.join('\n') + '\n\n';
}

/** Injects the stored Bearer token; the value is never logged or echoed (NFR-1). */
async function attachAuthorization(headers: Record<string, string>, context: ToolContext, apiId: string): Promise<void> {
	const token = await context.tokens.getToken(apiId);
	if (token !== undefined) {
		headers.Authorization = `Bearer ${token}`;
	}
}

function performRequest(request: ReturnType<typeof buildRequest>): Promise<Response> {
	return fetch(request.url, {
		method: request.method,
		headers: request.headers,
		body: request.body,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
}

function structuredError(error: string, url: string): Record<string, unknown> {
	return {
		error,
		url,
		hint: 'Correct the arguments and retry, or pick a different operation.',
	};
}

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
	return excerpt(serialized, BODY_PREVIEW_LIMIT);
}

function excerpt(text: string, limit = EXCERPT_LIMIT): string {
	return text.length > limit ? `${text.slice(0, limit)}… [truncated ${text.length - limit} more characters]` : text;
}
