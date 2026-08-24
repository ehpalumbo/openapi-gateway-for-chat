import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseSpec } from '../core/openapi';
import { buildApiModel } from '../core/operations';
import { ApiRegistration } from '../core/types';
import { ApiRegistry } from '../store/registry';
import { createInvokeOperationTool } from '../vscode/tools/invocation';
import { registerGatewayTools } from '../vscode/tools';

const FIXTURES = path.resolve(__dirname, '../../src/test/fixtures');
const TOKEN = 's3cr3t-do-not-echo';

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

async function invoke(name: string, input: Record<string, unknown>): Promise<unknown> {
	const result = await vscode.lm.invokeTool(
		name,
		{ input, toolInvocationToken: undefined },
		new vscode.CancellationTokenSource().token
	);
	const part = result.content[0];
	assert.ok(part instanceof vscode.LanguageModelTextPart, 'expected a single text part');
	return JSON.parse((part as vscode.LanguageModelTextPart).value);
}

/**
 * Drives `gateway_invoke_operation` end-to-end against an ephemeral local
 * HTTP server: the suite asserts the server receives exactly the request the
 * builder specified and that errors surface as structured results.
 */
suite('Invocation flow', () => {
	let registry: ApiRegistry;
	let tokens: { setToken(apiId: string, token: string): Promise<void>; getToken(apiId: string): Promise<string | undefined> };
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
				if (req.method === 'POST' && req.url === '/pets') {
					res.writeHead(201, { 'content-type': 'application/json' });
					res.end(Buffer.concat(chunks).toString('utf8'));
					return;
				}
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ id: 42, name: 'Rex' }));
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
		registerGatewayTools({ registry, tokens });
	});

	suiteTeardown(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	test('successful GET round-trip sends exactly the built request', async () => {
		const payload = (await invoke('gateway_invoke_operation', {
			apiId: 'echo',
			operationId: 'getPetById',
			pathParams: { petId: 42 },
			queryParams: { verbose: true },
			headers: { 'X-Trace-Id': 't-100' },
		})) as { status?: number; body?: { id: number; name: string }; error?: string };

		assert.strictEqual(payload.error, undefined);
		assert.strictEqual(payload.status, 200);
		assert.deepStrictEqual(payload.body, { id: 42, name: 'Rex' });

		assert.strictEqual(requests.length, 1);
		const seen = requests[0];
		assert.strictEqual(seen.method, 'GET');
		assert.strictEqual(seen.url, '/pets/42?verbose=true');
		assert.strictEqual(seen.headers['x-trace-id'], 't-100');
	});

	test('missing required path param fails fast without any network traffic', async () => {
		const before = requests.length;
		const payload = (await invoke('gateway_invoke_operation', {
			apiId: 'echo',
			operationId: 'getPetById',
		})) as { error?: string; status?: number };

		assert.match(payload.error ?? '', /petId/);
		assert.match(payload.error ?? '', /required/i);
		assert.strictEqual(payload.status, undefined);
		assert.strictEqual(requests.length, before, 'no request should reach the server');
	});

	test('prepareInvocation confirms non-safe methods with URL and redacted auth, safe methods not at all', async () => {
		const invokeTool = createInvokeOperationTool({ registry, tokens });

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
		const payload = (await invoke('gateway_invoke_operation', {
			apiId: 'echo',
			operationId: 'getPetById',
			pathParams: { petId: 42 },
		})) as { status?: number };

		assert.strictEqual(payload.status, 200);
		const last = requests[requests.length - 1];
		assert.strictEqual(last.headers.authorization, `Bearer ${TOKEN}`);
		assert.ok(!JSON.stringify(payload).includes(TOKEN), 'token must not leak into tool output');
	});

	test('a 500 response yields a structured error result with status and body excerpt', async () => {
		const payload = (await invoke('gateway_invoke_operation', {
			apiId: 'echo',
			operationId: 'detonate',
		})) as { error?: string; url?: string; status?: number; bodyExcerpt?: string };

		assert.match(payload.error ?? '', /HTTP 500/);
		assert.strictEqual(payload.status, 500);
		assert.strictEqual(payload.url, `${baseUrl}/boom`);
		assert.match(payload.bodyExcerpt ?? '', /kaboom/);
	});
});
