import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseSpec } from '../core/openapi';
import { buildApiModel } from '../core/operations';
import { ApiRegistration } from '../core/types';
import { ApiRegistry } from '../store/registry';
import { createInvokeOperationTool } from '../vscode/tools/invocation';
import { registerGatewayTools } from '../vscode/tools';
import { WorkspaceSpillStore } from '../vscode/spills';

const FIXTURES = path.resolve(__dirname, '../../src/test/fixtures');
const TOKEN = 's3cr3t-do-not-echo';

/** Deterministic JSON payload large enough to exercise whole-body inlining. */
const LARGE_REPORT = JSON.stringify({
	items: Array.from({ length: 150 }, (_, i) => ({
		id: i,
		name: `item-${i}`,
		description: 'd'.repeat(96),
	})),
});

/** Smallest valid-enough PNG header block; only the content type matters. */
const LOGO_PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

/** Minimal PDF-looking bytes; only the content type matters. */
const REPORT_PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3]);

/** The exact small-JSON body served by the default route. */
const SMALL_JSON = JSON.stringify({ id: 42, name: 'Rex' });

interface RecordedRequest {
	method: string;
	url: string;
	headers: http.IncomingHttpHeaders;
	body: string;
}

function readFixture(name: string): string {
	return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

class FakeMemento implements vscode.Memento {
	private readonly values = new Map<string, unknown>();

	get<T>(key: string): T | undefined;
	get<T>(key: string, defaultValue: T): T;
	get<T>(key: string, defaultValue?: T): T | undefined {
		const value = this.values.get(key);
		return value === undefined ? defaultValue : (value as T);
	}

	update(key: string, value: unknown): Thenable<void> {
		this.values.set(key, value);
		return Promise.resolve();
	}

	keys(): readonly string[] {
		return [...this.values.keys()];
	}
}

/**
 * The uniform tool-result shape under test (R-RESP-1): part one is the
 * response metadata as plain text mimicking the raw HTTP head (bare status
 * line, headers in arrival order lower-case, blank line — `statusLine\nh: v\n\n`);
 * part two — when present — is the body: a text part for textual bodies and
 * spill references, or an image data part for vision-safe image MIME types.
 * Responses without a body (strict `byteLength===0`, e.g. `204`, empty `404`)
 * return only the metadata part.
 */
interface InvokeOutcome {
	metadata: { status?: number; statusLine?: string; headers?: Record<string, string> };
	rawMetadata: string;
	bodyText?: string;
	imageDataPart?: vscode.LanguageModelDataPart;
}

function parseResponseHead(text: string): { status?: number; statusLine?: string; headers?: Record<string, string> } {
	const lines = text.split('\n');
	const statusLine = lines[0] ?? '';
	const headers: Record<string, string> = {};
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line === '') {
			break;
		}
		const colon = line.indexOf(':');
		if (colon === -1) {
			continue;
		}
		const key = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();
		headers[key] = value;
	}
	const status = statusLine ? parseInt(statusLine.split(' ')[0] ?? '', 10) : undefined;
	return { status: Number.isNaN(status) ? undefined : status, statusLine, headers };
}

async function invoke(name: string, input: Record<string, unknown>): Promise<InvokeOutcome> {
	const result = await vscode.lm.invokeTool(
		name,
		{ input, toolInvocationToken: undefined },
		new vscode.CancellationTokenSource().token
	);
	assert.strictEqual(result.content.length, 2, 'expected exactly two parts (metadata + body)');
	assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart, 'first part must be a text part');
	const rawMetadata = (result.content[0] as vscode.LanguageModelTextPart).value;
	assert.ok(rawMetadata.endsWith('\n\n'), 'metadata must end with blank line (statusLine\\nheaders\\n\\n)');
	const metadata = parseResponseHead(rawMetadata);
	const bodyPart = result.content[1];
	if (bodyPart instanceof vscode.LanguageModelTextPart) {
		return { metadata, rawMetadata, bodyText: bodyPart.value };
	}
	assert.ok(bodyPart instanceof vscode.LanguageModelDataPart, 'second part must be a text or image data part');
	return { metadata, rawMetadata, imageDataPart: bodyPart as vscode.LanguageModelDataPart };
}

async function invokeExpectSinglePart(name: string, input: Record<string, unknown>): Promise<InvokeOutcome> {
	const result = await vscode.lm.invokeTool(
		name,
		{ input, toolInvocationToken: undefined },
		new vscode.CancellationTokenSource().token
	);
	assert.strictEqual(result.content.length, 1, 'expected exactly one part (metadata only) for empty body');
	assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart, 'single part must be a text part');
	const rawMetadata = (result.content[0] as vscode.LanguageModelTextPart).value;
	assert.ok(rawMetadata.endsWith('\n\n'), 'metadata must end with blank line (statusLine\\nheaders\\n\\n)');
	const metadata = parseResponseHead(rawMetadata);
	return { metadata, rawMetadata };
}

/**
 * Drives `gateway_invoke_operation` end-to-end against an ephemeral local
 * HTTP server: the suite asserts the server receives exactly the request the
 * builder specified, that errors surface as structured results, and that
 * every HTTP response is served as uniform metadata + body data parts.
 */
suite('Invocation flow', () => {
	let registry: ApiRegistry;
	let tokens: { setToken(apiId: string, token: string): Promise<void>; getToken(apiId: string): Promise<string | undefined> };
	let spills: WorkspaceSpillStore;
	let spillDir: string;
	let server: http.Server;
	let baseUrl: string;
	let requests: RecordedRequest[];

	suiteSetup(async () => {
		requests = [];
		server = http.createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => chunks.push(chunk));
			req.on('end', () => {
				requests.push({
					method: req.method ?? '',
					url: req.url ?? '',
					headers: req.headers,
					body: Buffer.concat(chunks).toString('utf8'),
				});
				if (req.url === '/boom') {
					res.writeHead(500, { 'content-type': 'text/plain' });
					res.end('kaboom');
					return;
				}
				if (req.url === '/reports/large') {
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(LARGE_REPORT);
					return;
				}
				if (req.url === '/logo.png') {
					res.writeHead(200, { 'content-type': 'image/png' });
					res.end(Buffer.from(LOGO_PNG));
					return;
				}
				if (req.url === '/report.pdf') {
					res.writeHead(200, { 'content-type': 'application/pdf' });
					res.end(Buffer.from(REPORT_PDF));
					return;
				}
				if (req.url === '/empty/204') {
					res.writeHead(204);
					res.end();
					return;
				}
				if (req.url === '/empty/404') {
					res.writeHead(404);
					res.end();
					return;
				}
				if (req.method === 'POST' && req.url === '/pets') {
					res.writeHead(201, { 'content-type': 'application/json' });
					res.end(Buffer.concat(chunks).toString('utf8'));
					return;
				}
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(SMALL_JSON);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		assert.ok(address && typeof address === 'object');
		baseUrl = `http://127.0.0.1:${address.port}`;

		const document = parseSpec(readFixture('echo30.json'));
		const registration: ApiRegistration = {
			apiId: 'echo',
			title: document.info.title,
			version: document.info.version,
			baseUrl,
			source: { kind: 'file', fsPath: path.join(FIXTURES, 'echo30.json') },
			snapshot: { document, model: buildApiModel(document) },
		};
		const stored = new Map<string, string>();
		tokens = {
			setToken: async (apiId, token) => void stored.set(apiId, token),
			getToken: async (apiId) => stored.get(apiId),
		};
		registry = new ApiRegistry(new FakeMemento());
		registry.upsert(registration);

		// A real store over an isolated tmpdir exercises the production
		// `workspace.fs` code paths while keeping workspace storage untouched.
		const storageRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openapi-gateway-spills-'));
		spillDir = path.join(storageRoot, 'response-spills');
		spills = new WorkspaceSpillStore(vscode.Uri.file(storageRoot));

		registerGatewayTools({ registry, tokens, spills });
	});

	suiteTeardown(async () => {
		await spills.cleanup();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	test('successful GET round-trip sends exactly the built request', async () => {
		const { metadata } = await invoke('gateway_invoke_operation', {
			apiId: 'echo',
			operationId: 'getPetById',
			pathParams: { petId: 42 },
			queryParams: { verbose: true },
			headers: { 'X-Trace-Id': 't-100' },
		});

		assert.strictEqual(metadata.status, 200);

		assert.strictEqual(requests.length, 1);
		const seen = requests[0];
		assert.strictEqual(seen.method, 'GET');
		assert.strictEqual(seen.url, '/pets/42?verbose=true');
		assert.strictEqual(seen.headers['x-trace-id'], 't-100');
	});

	test('a small JSON response arrives as metadata plus a text part with the exact body', async () => {
		const { metadata, bodyText } = await invoke('gateway_invoke_operation', {
			apiId: 'echo',
			operationId: 'getPetById',
			pathParams: { petId: 42 },
		});

		assert.strictEqual(metadata.status, 200);
		assert.match(metadata.statusLine ?? '', /^200/);
		assert.match(metadata.headers?.['content-type'] ?? '', /application\/json/);
		assert.strictEqual(bodyText, SMALL_JSON);
	});

	test('a large JSON response is still served whole as text', async () => {
		const { metadata, bodyText } = await invoke('gateway_invoke_operation', { apiId: 'echo', operationId: 'getLargeReport' });

		assert.strictEqual(metadata.status, 200);
		assert.strictEqual(bodyText, LARGE_REPORT);
	});

	test('a PNG response is served as an image data part with its MIME type', async () => {
		const { metadata, imageDataPart, bodyText } = await invoke('gateway_invoke_operation', { apiId: 'echo', operationId: 'getLogo' });

		assert.strictEqual(metadata.status, 200);
		assert.strictEqual(bodyText, undefined);
		assert.ok(imageDataPart instanceof vscode.LanguageModelDataPart, 'PNG bodies must be image data parts');
		assert.strictEqual(imageDataPart.mimeType, 'image/png');
		assert.deepStrictEqual(Array.from(imageDataPart.data), Array.from(LOGO_PNG));
	});

	test('a non-image binary response spills to an existing file referenced by path', async () => {
		const first = await invoke('gateway_invoke_operation', { apiId: 'echo', operationId: 'getPdfReport' });
		const second = await invoke('gateway_invoke_operation', { apiId: 'echo', operationId: 'getPdfReport' });

		for (const outcome of [first, second]) {
			assert.strictEqual(outcome.metadata.status, 200);
			assert.match(outcome.metadata.headers?.['content-type'] ?? '', /application\/pdf/);
			const spill = JSON.parse(outcome.bodyText ?? '{}') as {
				contentType?: string;
				byteSize?: number;
				filePath?: string;
				hint?: string;
			};
			assert.strictEqual(spill.contentType, 'application/pdf');
			assert.strictEqual(spill.byteSize, REPORT_PDF.byteLength);
			assert.match(spill.filePath ?? '', /\.pdf$/, 'PDF spills keep the .pdf extension');
			assert.match(spill.hint ?? '', /open the file/i);
			assert.ok(fs.existsSync(spill.filePath ?? ''), 'spilled file must exist on disk');
			assert.deepStrictEqual(
				new Uint8Array(fs.readFileSync(spill.filePath ?? '')),
				REPORT_PDF,
				'spilled bytes must match the served body'
			);
		}
		const firstPath = JSON.parse(first.bodyText ?? '{}') as { filePath?: string };
		const secondPath = JSON.parse(second.bodyText ?? '{}') as { filePath?: string };
		assert.notStrictEqual(firstPath.filePath, secondPath.filePath, 'repeated spills must never override each other');
	});

	test('missing required path param fails fast without any network traffic', async () => {
		const before = requests.length;
		const result = await vscode.lm.invokeTool(
			'gateway_invoke_operation',
			{ input: { apiId: 'echo', operationId: 'getPetById' }, toolInvocationToken: undefined },
			new vscode.CancellationTokenSource().token
		);
		assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart, 'validation errors stay text results');
		const payload = JSON.parse((result.content[0] as vscode.LanguageModelTextPart).value) as {
			error?: string;
			status?: number;
		};

		assert.match(payload.error ?? '', /petId/);
		assert.match(payload.error ?? '', /required/i);
		assert.strictEqual(payload.status, undefined);
		assert.strictEqual(requests.length, before, 'no request should reach the server');
	});

	test('prepareInvocation confirms non-safe methods with URL and redacted auth, safe methods not at all', async () => {
		const invokeTool = createInvokeOperationTool({ registry, tokens, spills });

		await tokens.setToken('echo', TOKEN);

		const post = await invokeTool.prepareInvocation!(
			{
				input: {
					apiId: 'echo',
					operationId: 'createPet',
					body: { name: 'Rex' },
				},
			},
			new vscode.CancellationTokenSource().token
		);
		assert.ok(post?.confirmationMessages, 'POST must require confirmation');
		const message = String((post.confirmationMessages as { message: { value: string } }).message.value);
		assert.match(message, /POST/);
		assert.match(message, new RegExp(baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/pets'));
		assert.match(message, /Authorization: Bearer \*\*\*/);
		assert.ok(!message.includes(TOKEN), 'confirmation must never show the raw token');
		assert.match(message, /"name": "Rex"/);

		const get = await invokeTool.prepareInvocation!(
			{
				input: { apiId: 'echo', operationId: 'getPetById', pathParams: { petId: 42 } },
			},
			new vscode.CancellationTokenSource().token
		);
		assert.strictEqual(get, undefined, 'GET must run without confirmation');
	});

	test('stored token is attached as Bearer auth but never appears in the result', async () => {
		const { metadata, rawMetadata } = await invoke('gateway_invoke_operation', {
			apiId: 'echo',
			operationId: 'getPetById',
			pathParams: { petId: 42 },
		});

		assert.strictEqual(metadata.status, 200);
		const last = requests[requests.length - 1];
		assert.strictEqual(last.headers.authorization, `Bearer ${TOKEN}`);
		assert.ok(!rawMetadata.includes(TOKEN) && !JSON.stringify(metadata).includes(TOKEN), 'token must not leak into tool output');
	});

	test('a 500 response follows the uniform shape: status in metadata, full error body as text', async () => {
		const { metadata, bodyText } = await invoke('gateway_invoke_operation', { apiId: 'echo', operationId: 'detonate' });

		assert.strictEqual(metadata.status, 500);
		assert.match(metadata.statusLine ?? '', /^500/);
		assert.strictEqual(bodyText, 'kaboom');
	});

	test('a 204 response without body returns only metadata, no body part or spill file', async () => {
		const beforeFiles = fs.existsSync(spillDir) ? fs.readdirSync(spillDir).length : 0;
		const { metadata, rawMetadata } = await invokeExpectSinglePart('gateway_invoke_operation', {
			apiId: 'echo',
			operationId: 'getNoContent',
		});

		assert.strictEqual(metadata.status, 204);
		assert.match(metadata.statusLine ?? '', /^204/);
		assert.ok(rawMetadata.endsWith('\n\n'), 'metadata must end with blank line');
		assert.strictEqual(metadata.headers?.['content-type'], undefined, '204 without body should not carry a content-type spill');
		const afterFiles = fs.existsSync(spillDir) ? fs.readdirSync(spillDir).length : 0;
		assert.strictEqual(afterFiles, beforeFiles, '204 without body must not create a spill file');
	});

	test('a 404 response without body returns only metadata, no body part or spill file', async () => {
		const beforeFiles = fs.existsSync(spillDir) ? fs.readdirSync(spillDir).length : 0;
		const { metadata, rawMetadata } = await invokeExpectSinglePart('gateway_invoke_operation', {
			apiId: 'echo',
			operationId: 'getEmptyNotFound',
		});

		assert.strictEqual(metadata.status, 404);
		assert.match(metadata.statusLine ?? '', /^404/);
		assert.ok(rawMetadata.endsWith('\n\n'), 'metadata must end with blank line');
		const afterFiles = fs.existsSync(spillDir) ? fs.readdirSync(spillDir).length : 0;
		assert.strictEqual(afterFiles, beforeFiles, 'empty 404 must not create a spill file');
	});

	test('cleanup removes every spilled file from the spill directory', async () => {
		await invoke('gateway_invoke_operation', { apiId: 'echo', operationId: 'getPdfReport' });
		assert.ok(fs.existsSync(spillDir) && fs.readdirSync(spillDir).length > 0, 'precondition: spills exist');

		await spills.cleanup();

		assert.ok(!fs.existsSync(spillDir) || fs.readdirSync(spillDir).length === 0, 'no spill files may remain');
	});
});
