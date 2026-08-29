import * as vscode from 'vscode';
import {
	ConfirmationDescriptor,
	HttpResponsePayload,
	InvokeOperationInput,
	NetworkErrorPayload,
	RequestBuildFailure,
} from '../../../application';
import { buildSpillFileName } from '../../../domain';
import { randomToken } from '../spills';
import { errorResult, textResult } from './common';
import { ToolContext } from './context';

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
	const result = await context.invokeUseCase.prepareInvocation(input);
	switch (result.kind) {
		case 'skip_confirmation':
		case 'not_found':
			return undefined;
		case 'invalid_invocation':
			return {
				invocationMessage: new vscode.MarkdownString(`OpenAPI Gateway: invalid invocation — ${result.error}`),
			};
		case 'needs_confirmation':
			return renderPreparedConfirmation(result.descriptor);
	}
}

function renderPreparedConfirmation(descriptor: ConfirmationDescriptor): vscode.PreparedToolInvocation {
	const lines = [
		`**${descriptor.method}** ${descriptor.url}`,
		'',
		'Headers:',
		'- Accept: application/json',
		descriptor.hasToken ? '- Authorization: Bearer ***' : undefined,
	].filter((line): line is string => line !== undefined);

	if (descriptor.bodyPreview !== undefined) {
		lines.push('', 'Body:', '```json', descriptor.bodyPreview, '```');
	}

	const message = new vscode.MarkdownString(lines.join('\n'));
	message.isTrusted = false;

	return {
		confirmationMessages: {
			title: descriptor.title,
			message,
		},
	};
}

async function invokeOperation(
	context: ToolContext,
	input: InvokeOperationInput
): Promise<vscode.LanguageModelToolResult> {
	const entry = context.registry.getEntry(input.apiId);
	if (!entry) {
		const available = context.registry.list().map((r) => r.apiId).join(', ');
		return errorResult(`Unknown apiId "${input.apiId}". Registered APIs: ${available || '(none)'}.`);
	}

	const operation = entry.index.get(input.operationId);
	if (!operation) {
		const available = [...entry.index.keys()].join(', ');
		return errorResult(`Unknown operationId "${input.operationId}". Available operations: ${available || '(none)'}.`);
	}

	const result = await context.invokeUseCase.execute(entry.registration, operation, input);
	switch (result.kind) {
		case 'response':
			return renderHttpResponse(entry.registration.apiId, operation.operationId, result, context);
		case 'network':
			return renderNetworkError(result);
		case 'build':
			return renderBuildFailure(result);
	}
}

async function renderHttpResponse(
	apiId: string,
	operationId: string,
	response: HttpResponsePayload,
	context: ToolContext
): Promise<vscode.LanguageModelToolResult> {
	const statusLine = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
	const metadataPart = new vscode.LanguageModelTextPart(formatResponseHead(statusLine, response.headers));
	if (!response.body) {
		return new vscode.LanguageModelToolResult([metadataPart]);
	}
	switch (response.body.class) {
		case 'text':
			return new vscode.LanguageModelToolResult([
				metadataPart,
				new vscode.LanguageModelTextPart(response.body.text),
			]);
		case 'image':
			return new vscode.LanguageModelToolResult([
				metadataPart,
				new vscode.LanguageModelDataPart(response.body.bytes, response.body.mimeType),
			]);
		case 'binary':
			return new vscode.LanguageModelToolResult([
				metadataPart,
				new vscode.LanguageModelTextPart(await spillBody(apiId, operationId, response, context)),
			]);
	}
}

async function spillBody(
	apiId: string,
	operationId: string,
	response: HttpResponsePayload,
	context: ToolContext
): Promise<string> {
	const spilled = response.body as { class: 'binary'; bytes: Uint8Array; mimeType: string };
	const fileName = buildSpillFileName(`${apiId}-${operationId}`, spilled.mimeType, randomToken);
	const filePath = await context.spills.write(fileName, spilled.bytes);
	return renderSpillNotice(spilled.mimeType, spilled.bytes.byteLength, filePath);
}

function renderSpillNotice(mimeType: string, byteSize: number, filePath: string): string {
	return (
		'[gateway notice, not API response content]\n' +
		`The response body was a non-image binary (${mimeType}; ${byteSize} bytes) that could not be rendered as text. It was saved to:\n` +
		`${filePath}\n` +
		'Use shell tools or open the file directly.'
	);
}

function formatResponseHead(statusLine: string, headers: Record<string, string>): string {
	const lines = [statusLine];
	for (const [key, value] of Object.entries(headers)) {
		lines.push(`${key}: ${value}`);
	}
	return lines.join('\n') + '\n\n';
}

function renderNetworkError(error: NetworkErrorPayload): vscode.LanguageModelToolResult {
	return textResult(structuredError(error.message, error.url));
}

function renderBuildFailure(error: RequestBuildFailure): vscode.LanguageModelToolResult {
	return textResult({ error: error.error });
}

function structuredError(error: string, url: string): Record<string, unknown> {
	return {
		error,
		url,
		hint: 'Correct the arguments and retry, or pick a different operation.',
	};
}
