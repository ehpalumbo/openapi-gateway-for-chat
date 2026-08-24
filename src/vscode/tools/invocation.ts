/**
 * The `gateway_invoke_operation` tool (R-INV-*): builds and executes HTTP
 * requests against a registered base URL with Bearer-token injection and
 * native safety confirmation (R-SAFE-*).
 *
 * Errors — network failure, non-2xx responses, builder validation — are
 * returned as structured results instead of throwing so the model can reason
 * about retry or correction (R-INV-5). The raw response is handed to the
 * pluggable {@link processResponse} seam, which Phase 5 replaces with
 * size-aware splitting and binary detection (R-RESP-*).
 */
import * as vscode from 'vscode';
import { buildRequest, InvokeInput, RequestBuildError } from '../../core/request-builder';
import { OperationInfo } from '../../core/types';
import { RegistryEntry } from '../../store/registry';
import { asRecord, errorResult, isFailure, readString, resolveEntry, textResult } from './common';
import { ToolContext } from './context';

/** Methods that never mutate state and therefore skip confirmation (R-SAFE-1). */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

/** Milliseconds before an in-flight HTTP request is aborted. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Characters of a request/response body shown before truncation. */
const BODY_PREVIEW_LIMIT = 600;
const EXCERPT_LIMIT = 1000;

/** An operation resolved together with its registration's runtime view. */
interface ResolvedOperation {
	entry: RegistryEntry;
	operation: OperationInfo;
}

export function createInvokeOperationTool(context: ToolContext): vscode.LanguageModelTool<unknown> {
	return {
		prepareInvocation: (options) => prepareInvocation(context, asRecord(options.input)),
		invoke: (options) => invokeOperation(context, asRecord(options.input)),
	};
}

/**
 * Decides whether the host must prompt before execution. Unknown inputs bail
 * out silently: `invoke` reports them as structured errors afterwards.
 */
async function prepareInvocation(
	context: ToolContext,
	input: Record<string, unknown>
): Promise<vscode.PreparedToolInvocation | undefined> {
	const resolved = resolveSilently(context.registry, input);
	if (!resolved || !shouldConfirm(resolved.operation)) {
		return undefined;
	}
	return buildConfirmation(resolved.entry, resolved.operation, input, context);
}

function resolveSilently(registry: ToolContext['registry'], input: Record<string, unknown>): ResolvedOperation | undefined {
	const apiId = readString(input, 'apiId');
	const operationId = readString(input, 'operationId');
	if (!apiId || !operationId || registry.list().length === 0) {
		return undefined;
	}
	const entry = registry.getEntry(apiId);
	const operation = entry?.index.get(operationId);
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
	input: Record<string, unknown>,
	context: ToolContext
): Promise<vscode.PreparedToolInvocation> {
	let url: string;
	try {
		url = buildRequest(entry.registration, operation, toInvokeInput(input)).url;
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
			message: renderConfirmationMarkdown(operation.method.toUpperCase(), url, hasToken, previewBody(input['body'])),
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

async function invokeOperation(context: ToolContext, input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
	const args = parseInvokeArgs(input);
	if (args instanceof vscode.LanguageModelToolResult) {
		return args;
	}
	const found = resolveEntry(context.registry, args.apiId);
	if (isFailure(found)) {
		return found;
	}
	const operation = found.index.get(args.operationId);
	if (!operation) {
		const available = [...found.index.keys()].join(', ');
		return errorResult(`Unknown operationId "${args.operationId}". Available operations: ${available}.`);
	}
	return executeOperation(found, operation, input, context);
}

type ParsedArgs = { apiId: string; operationId: string } | vscode.LanguageModelToolResult;

function parseInvokeArgs(input: Record<string, unknown>): ParsedArgs {
	const apiId = readString(input, 'apiId');
	if (!apiId) {
		return errorResult('Missing required string parameter "apiId".');
	}
	const operationId = readString(input, 'operationId');
	if (!operationId) {
		return errorResult('Missing required string parameter "operationId".');
	}
	return { apiId, operationId };
}

/**
 * Builds the request, attaches authentication, performs the call, and maps
 * every failure mode onto a structured result payload.
 */
async function executeOperation(
	entry: RegistryEntry,
	operation: OperationInfo,
	input: Record<string, unknown>,
	context: ToolContext
): Promise<vscode.LanguageModelToolResult> {
	let request;
	try {
		request = buildRequest(entry.registration, operation, toInvokeInput(input));
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
	return textResult(await processResponse(response));
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

/**
 * Turns a raw HTTP response into the tool-result payload. Phase 4 inlines
 * text for everything; Phase 5 swaps this implementation without touching
 * the rest of the tool.
 */
type ResponseProcessor = (response: Response) => Promise<unknown>;

const processResponse: ResponseProcessor = async (response) => {
	const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
	const raw = await response.text();
	if (!response.ok) {
		return structuredError(
			`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}: the server rejected the request.`,
			response.url,
			response.status,
			excerpt(raw)
		);
	}
	const body = isJsonContentType(contentType) ? parseJsonOrText(raw) : raw;
	return { status: response.status, contentType, body };
};

function structuredError(error: string, url: string, status?: number, bodyExcerpt?: string): Record<string, unknown> {
	return {
		error,
		url,
		...(status !== undefined ? { status } : {}),
		...(bodyExcerpt !== undefined ? { bodyExcerpt } : {}),
		hint: 'Correct the arguments and retry, or pick a different operation.',
	};
}

function toInvokeInput(input: Record<string, unknown>): InvokeInput {
	return {
		pathParams: asRecord(input['pathParams']),
		queryParams: asRecord(input['queryParams']),
		headers: asRecord(input['headers']),
		body: input['body'],
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

function isJsonContentType(contentType: string): boolean {
	return contentType.split(';')[0].trim().endsWith('/json') || contentType.includes('+json');
}

function parseJsonOrText(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}
