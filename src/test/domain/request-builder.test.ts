import * as assert from 'assert';
import { ApiRegistration, BodyFileReader, FileDescriptor, InvokeInput, OperationInfo, RequestBuilder, RequestBuildError } from '../../domain';

function registration(baseUrl: string): ApiRegistration {
	return {
		apiId: 'petshop',
		title: 'Petshop',
		version: '1.0.0',
		baseUrl,
		source: { kind: 'url', url: 'https://spec.example.com/petshop.json' },
		snapshot: {
			model: { info: { title: 'Petshop', version: '1.0.0' }, schemas: {}, groups: [] },
		},
	};
}

function operation(overrides: Partial<OperationInfo> = {}): OperationInfo {
	return {
		operationId: 'getPetById',
		declaredOperationId: true,
		group: 'default',
		method: 'get',
		pathTemplate: '/pets/{petId}',
		parameters: [
			{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } },
			{ name: 'verbose', in: 'query', required: false, schema: { type: 'boolean' } },
			{ name: 'tags', in: 'query', required: false, schema: { type: 'array', items: { type: 'string' } } },
			{ name: 'X-Trace-Id', in: 'header', required: false, schema: { type: 'string' } },
		],
		responses: {},
		...overrides,
	};
}

const noopReader: BodyFileReader = {
	async stat(llmPath: string): Promise<FileDescriptor> {
		throw new RequestBuildError(`stat should not be called for "${llmPath}"`);
	},
	async read(llmPath: string): Promise<Uint8Array> {
		throw new RequestBuildError(`read should not be called for "${llmPath}"`);
	},
};

function makeBuilder(): RequestBuilder {
	return new RequestBuilder(noopReader);
}

suite('Request builder', () => {
	test('substitutes path params into the template against the base URL', async () => {
		const request = await makeBuilder().build(registration('https://api.example.com/v1'), operation(), {
			pathParams: { petId: 42 },
		});
		assert.strictEqual(request.method, 'GET');
		assert.strictEqual(request.url, 'https://api.example.com/v1/pets/42');
	});

	test('normalizes trailing slashes between the base URL and path template', async () => {
		const slashed = await makeBuilder().build(registration('https://api.example.com/v1/'), operation(), {
			pathParams: { petId: 42 },
		});
		const bare = await makeBuilder().build(registration('https://api.example.com'), operation(), {
			pathParams: { petId: 42 },
		});
		assert.strictEqual(slashed.url, 'https://api.example.com/v1/pets/42');
		assert.strictEqual(bare.url, 'https://api.example.com/pets/42');
	});

	test('missing required path params fail fast enumerating exactly which are required', async () => {
		const op = operation({
			pathTemplate: '/pets/{petId}/toys/{toyId}',
			parameters: [
				{ name: 'petId', in: 'path', required: true },
				{ name: 'toyId', in: 'path', required: true },
				{ name: 'verbose', in: 'query', required: false },
			],
		});
		await assert.rejects(
			() => makeBuilder().build(registration('https://api.example.com/v1'), op, {}),
			(error: unknown) => {
				assert.ok(error instanceof RequestBuildError);
				assert.match(error.message, /petId, toyId/);
				return true;
			}
		);
	});

	test('empty-string path param counts as missing', async () => {
		await assert.rejects(() => makeBuilder().build(registration('https://api.example.com/v1'), operation(), {
			pathParams: { petId: '' },
		}), RequestBuildError);
	});

	test('path values are encoded so they cannot alter the target origin', async () => {
		const request = await makeBuilder().build(registration('https://api.example.com/v1'), operation(), {
			pathParams: { petId: '../admin#x' },
		});
		assert.strictEqual(request.url, 'https://api.example.com/v1/pets/..%2Fadmin%23x');
	});

	test('array query params render as repeated keys and booleans as lowercase', async () => {
		const request = await makeBuilder().build(registration('https://api.example.com/v1'), operation(), {
			pathParams: { petId: 7 },
			queryParams: { verbose: true, tags: ['cute', 'brown'] },
		});
		const url = new URL(request.url);
		assert.strictEqual(url.searchParams.getAll('tags').join(','), 'cute,brown');
		assert.strictEqual(url.searchParams.get('verbose'), 'true');
	});

	test('number query params serialize plainly and null values are dropped', async () => {
		const op = operation({
			pathTemplate: '/pets',
			parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }],
		});
		const request = await makeBuilder().build(registration('https://api.example.com/v1'), op, {
			queryParams: { limit: 10, skip: null },
		});
		assert.strictEqual(request.url, 'https://api.example.com/v1/pets?limit=10');
	});

	test('user headers merge under spec-declared header parameters', async () => {
		const request = await makeBuilder().build(registration('https://api.example.com/v1'), operation(), {
			pathParams: { petId: 1 },
			headers: { Accept: 'application/xml' },
		});
		assert.strictEqual(request.headers['X-Trace-Id'], undefined);
		assert.strictEqual(request.headers.Accept, 'application/xml');
	});

	test('header params declared by the spec are sent when provided via headers input', async () => {
		const request = await makeBuilder().build(registration('https://api.example.com/v1'), operation(), {
			pathParams: { petId: 1 },
			queryParams: {},
			headers: { 'X-Trace-Id': 'abc-123' },
		});
		assert.strictEqual(request.headers['X-Trace-Id'], 'abc-123');
	});

	test('rejects attempts to override Host or Authorization via header injection', async () => {
		for (const name of ['Host', 'host', 'HOST', 'Authorization']) {
			await assert.rejects(
				() =>
					makeBuilder().build(registration('https://api.example.com/v1'), operation(), {
						pathParams: { petId: 1 },
						headers: { [name]: 'https://evil.example.com' },
					}),
				RequestBuildError,
				`expected ${name} to be rejected`
			);
		}
	});

	test('body passes through as JSON with a Content-Type header when supplied', async () => {
		const op = operation({
			method: 'post',
			pathTemplate: '/pets',
			parameters: [],
			requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
		});
		const request = await makeBuilder().build(registration('https://api.example.com/v1'), op, {
			body: { name: 'Rex' },
		} satisfies InvokeInput);
		assert.strictEqual(request.method, 'POST');
		assert.strictEqual(request.body, '{"name":"Rex"}');
		assert.strictEqual(request.headers['Content-Type'], 'application/json');
	});

	test('array body is JSON-stringified', async () => {
		const op = operation({
			method: 'post',
			pathTemplate: '/pets/batch',
			parameters: [],
			requestBody: { required: true, content: { 'application/json': { schema: { type: 'array' } } } },
		});
		const request = await makeBuilder().build(registration('https://api.example.com/v1'), op, {
			body: [{ name: 'Rex' }, { name: 'Fido' }],
		} satisfies InvokeInput);
		assert.strictEqual(request.body, '[{"name":"Rex"},{"name":"Fido"}]');
		assert.strictEqual(request.headers['Content-Type'], 'application/json');
	});

	test('string body is sent verbatim without JSON stringification', async () => {
		const op = operation({
			method: 'post',
			pathTemplate: '/pets',
			parameters: [],
			requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
		});
		const rawJson = '{"name":"Rex"}';
		const request = await makeBuilder().build(registration('https://api.example.com/v1'), op, {
			body: rawJson,
		} satisfies InvokeInput);
		assert.strictEqual(request.body, rawJson);
		// Must NOT be double-stringified: '"{\\"name\\":\\"Rex\\"}"'
		assert.notStrictEqual(request.body, JSON.stringify(rawJson));
		assert.strictEqual(request.headers['Content-Type'], 'application/json');
	});

	test('plain text string body is sent verbatim with text/plain Content-Type', async () => {
		const op = operation({
			method: 'post',
			pathTemplate: '/pets',
			parameters: [],
			requestBody: { required: true, content: { 'text/plain': { schema: { type: 'string' } } } },
		});
		const request = await makeBuilder().build(registration('https://api.example.com/v1'), op, {
			body: 'hello world',
		} satisfies InvokeInput);
		assert.strictEqual(request.body, 'hello world');
		assert.strictEqual(request.headers['Content-Type'], 'text/plain');
	});

	test('string body Content-Type is inferred from declared spec when available', async () => {
		const op = operation({
			method: 'post',
			pathTemplate: '/pets',
			parameters: [],
			requestBody: { required: true, content: { 'application/xml': { schema: { type: 'string' } } } },
		});
		const request = await makeBuilder().build(registration('https://api.example.com/v1'), op, {
			body: '<pet><name>Rex</name></pet>',
		} satisfies InvokeInput);
		assert.strictEqual(request.body, '<pet><name>Rex</name></pet>');
		assert.strictEqual(request.headers['Content-Type'], 'application/xml');
	});

	test('user-supplied Content-Type header is not overwritten', async () => {
		const op = operation({
			method: 'post',
			pathTemplate: '/pets',
			parameters: [],
			requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
		});
		const request = await makeBuilder().build(registration('https://api.example.com/v1'), op, {
			body: { name: 'Rex' },
			headers: { 'Content-Type': 'application/custom+json' },
		} satisfies InvokeInput);
		assert.strictEqual(request.body, '{"name":"Rex"}');
		assert.strictEqual(request.headers['Content-Type'], 'application/custom+json');

		const stringReq = await makeBuilder().build(registration('https://api.example.com/v1'), op, {
			body: '{"name":"Rex"}',
			headers: { 'content-type': 'text/plain' },
		} satisfies InvokeInput);
		assert.strictEqual(stringReq.body, '{"name":"Rex"}');
		assert.strictEqual(stringReq.headers['content-type'], 'text/plain');
		assert.strictEqual('Content-Type' in stringReq.headers, false);
	});

	test('string JSON without declared spec infers application/json, non-JSON infers text/plain', async () => {
		const opNoSpec = operation({
			method: 'post',
			pathTemplate: '/raw',
			parameters: [],
		});
		const jsonReq = await makeBuilder().build(registration('https://api.example.com/v1'), opNoSpec, {
			body: '{"a":1}',
		} satisfies InvokeInput);
		assert.strictEqual(jsonReq.headers['Content-Type'], 'application/json');

		const textReq = await makeBuilder().build(registration('https://api.example.com/v1'), opNoSpec, {
			body: 'hello world',
		} satisfies InvokeInput);
		assert.strictEqual(textReq.headers['Content-Type'], 'text/plain');
	});

	test('no body is set when the caller supplies none', async () => {
		const request = await makeBuilder().build(registration('https://api.example.com/v1'), operation(), {
			pathParams: { petId: 1 },
		});
		assert.strictEqual(request.body, undefined);
		assert.strictEqual('Content-Type' in request.headers, false);
	});
});

class FakeBodyFileReader implements BodyFileReader {
	public statCalls: string[] = [];
	public readCalls: string[] = [];
	constructor(
		private readonly statMap: Record<string, FileDescriptor> = {},
		private readonly readMap: Record<string, Uint8Array> = {},
		private readonly shouldThrowStat?: (path: string) => Error | undefined,
	) { }
	async stat(llmPath: string): Promise<FileDescriptor> {
		this.statCalls.push(llmPath);
		const err = this.shouldThrowStat?.(llmPath);
		if (err) { throw err; }
		const fd = this.statMap[llmPath];
		if (!fd) {
			throw new RequestBuildError(`Body file not found or not accessible: "${llmPath}": not found`);
		}
		return fd;
	}
	async read(llmPath: string): Promise<Uint8Array> {
		this.readCalls.push(llmPath);
		const data = this.readMap[llmPath];
		if (data) { return data; }
		return new TextEncoder().encode(`content of ${llmPath}`);
	}
}

function postOperation(overrides: Partial<OperationInfo> = {}): OperationInfo {
	return {
		operationId: 'createPet',
		declaredOperationId: true,
		group: 'default',
		method: 'post',
		pathTemplate: '/pets',
		parameters: [],
		responses: {},
		...overrides,
	};
}

suite('Request builder with bodyFile', () => {
	test('xor validation: body and bodyFile together throws', async () => {
		const reader = new FakeBodyFileReader({ 'data.json': { size: 1234 } });
		const builder = new RequestBuilder(reader);
		await assert.rejects(
			() => builder.build(registration('https://api.example.com'), postOperation(), { body: { name: 'Rex' }, bodyFile: 'data.json' }),
			(err: unknown) => {
				assert.ok(err instanceof RequestBuildError);
				assert.match((err as Error).message, /Provide either/);
				return true;
			}
		);
	});

	test('missing file stat throws RequestBuildError containing path', async () => {
		const reader = new FakeBodyFileReader({});
		const builder = new RequestBuilder(reader);
		await assert.rejects(
			() => builder.build(registration('https://api.example.com'), postOperation(), { bodyFile: 'missing.json' }),
			(err: unknown) => {
				assert.ok(err instanceof RequestBuildError);
				assert.match((err as Error).message, /missing\.json/);
				assert.match((err as Error).message, /Body file not found/);
				return true;
			}
		);
	});

	test('file:// URI is accepted and extension inferred correctly', async () => {
		const reader = new FakeBodyFileReader({ 'file:///tmp/payload.json': { size: 10 } });
		const builder = new RequestBuilder(reader);
		const req = await builder.build(registration('https://api.example.com'), postOperation(), { bodyFile: 'file:///tmp/payload.json' });
		assert.strictEqual(req.bodyFile, 'file:///tmp/payload.json');
		assert.strictEqual(typeof req.body, 'function');
		assert.strictEqual(req.headers['Content-Type'], 'application/json');
		assert.strictEqual(req.bodySize, 10);
		assert.deepStrictEqual(reader.statCalls, ['file:///tmp/payload.json']);
	});

	test('relative path resolves via stat and preserves bodyFile value', async () => {
		const reader = new FakeBodyFileReader({ 'a/b.json': { size: 42 } });
		const builder = new RequestBuilder(reader);
		const req = await builder.build(registration('https://api.example.com'), postOperation(), { bodyFile: 'a/b.json' });
		assert.strictEqual(req.bodyFile, 'a/b.json');
		assert.strictEqual(req.bodySize, 42);
	});

	test('bodySize for inline and file', async () => {
		const reader = new FakeBodyFileReader({ 'data.json': { size: 1234 } });
		const builder = new RequestBuilder(reader);
		const inline = await builder.build(registration('https://api.example.com'), postOperation(), { body: { a: 1 } });
		const expectedInline = Buffer.byteLength(JSON.stringify({ a: 1 }), 'utf8');
		assert.strictEqual(inline.bodySize, expectedInline);
		assert.strictEqual(typeof inline.body, 'string');
		// string body '{"a":1}' should also have size 7
		const inlineStr = await builder.build(registration('https://api.example.com'), postOperation({ requestBody: { content: { 'text/plain': {} } } }), { body: '{"a":1}' });
		assert.strictEqual(inlineStr.bodySize, Buffer.byteLength('{"a":1}', 'utf8'));
		assert.strictEqual(inlineStr.bodySize, 7);
		const file = await builder.build(registration('https://api.example.com'), postOperation(), { bodyFile: 'data.json' });
		assert.strictEqual(file.bodySize, 1234);
		assert.strictEqual(typeof file.body, 'function');
		const supplier = file.body as () => Promise<Uint8Array>;
		const bytes = await supplier();
		assert.ok(bytes instanceof Uint8Array);
	});

	test('Content-Type via extension', async () => {
		const cases: Array<[string, string]> = [
			['data.json', 'application/json'],
			['data.txt', 'text/plain'],
			['data.xml', 'application/xml'],
			['data.html', 'text/html'],
			['data.htm', 'text/html'],
			['data.bin', 'application/octet-stream'],
			['data', 'application/octet-stream'],
			['file:///tmp/foo.json', 'application/json'],
			['file:///tmp/foo.TXT', 'text/plain'],
		];
		for (const [file, expected] of cases) {
			const reader = new FakeBodyFileReader({ [file]: { size: 5 } });
			const builder = new RequestBuilder(reader);
			const req = await builder.build(registration('https://api.example.com'), postOperation(), { bodyFile: file });
			assert.strictEqual(req.headers['Content-Type'], expected, `expected ${expected} for ${file}`);
		}
	});

	test('spec-declared content first key overrides extension', async () => {
		const op = postOperation({ requestBody: { content: { 'application/custom': {}, 'application/json': {} } } });
		const reader = new FakeBodyFileReader({ 'data.json': { size: 5 } });
		const builder = new RequestBuilder(reader);
		const req = await builder.build(registration('https://api.example.com'), op, { bodyFile: 'data.json' });
		assert.strictEqual(req.headers['Content-Type'], 'application/custom');
	});

	test('explicit Content-Type header takes precedence over spec and extension', async () => {
		const op = postOperation({ requestBody: { content: { 'application/json': {} } } });
		const reader = new FakeBodyFileReader({ 'data.json': { size: 5 } });
		const builder = new RequestBuilder(reader);
		const req = await builder.build(registration('https://api.example.com'), op, { bodyFile: 'data.json', headers: { 'Content-Type': 'text/csv' } });
		assert.strictEqual(req.headers['Content-Type'], 'text/csv');
		// case-insensitive header key preserved
		const req2 = await builder.build(registration('https://api.example.com'), op, { bodyFile: 'data.json', headers: { 'content-type': 'text/csv' } });
		assert.strictEqual(req2.headers['content-type'], 'text/csv');
		assert.strictEqual('Content-Type' in req2.headers, false);
	});

	test('required body satisfied by file path', async () => {
		const op = postOperation({ requestBody: { required: true, content: { 'application/json': {} } } });
		const reader = new FakeBodyFileReader({ 'data.json': { size: 5 } });
		const builder = new RequestBuilder(reader);
		const req = await builder.build(registration('https://api.example.com'), op, { bodyFile: 'data.json' });
		assert.strictEqual(req.bodyFile, 'data.json');
		// missing both should still throw
		await assert.rejects(
			() => builder.build(registration('https://api.example.com'), op, {}),
			RequestBuildError
		);
	});

	test('http:// path rejected via reader error propagation', async () => {
		const reader = new FakeBodyFileReader({}, {}, (p) => {
			if (p.startsWith('http://') || p.startsWith('https://')) {
				return new RequestBuildError(`Only local files are supported for bodyFile, got: "${p}"`);
			}
			return undefined;
		});
		const builder = new RequestBuilder(reader);
		await assert.rejects(
			() => builder.build(registration('https://api.example.com'), postOperation(), { bodyFile: 'https://evil.com/payload.json' }),
			(err: unknown) => {
				assert.ok(err instanceof RequestBuildError);
				assert.match((err as Error).message, /Only local files/);
				return true;
			}
		);
		await assert.rejects(
			() => builder.build(registration('https://api.example.com'), postOperation(), { bodyFile: 'http://evil.com/payload.json' }),
			(err: unknown) => {
				assert.ok(err instanceof RequestBuildError);
				assert.match((err as Error).message, /Only local files/);
				return true;
			}
		);
	});

	test('inline body still yields string and spec fallback', async () => {
		const reader = new FakeBodyFileReader();
		const builder = new RequestBuilder(reader);
		const opNoContent = postOperation();
		const reqJson = await builder.build(registration('https://api.example.com'), opNoContent, { body: '{"a":1}' });
		assert.strictEqual(reqJson.headers['Content-Type'], 'application/json');
		const reqText = await builder.build(registration('https://api.example.com'), opNoContent, { body: 'hello' });
		assert.strictEqual(reqText.headers['Content-Type'], 'text/plain');
	});

	test('GET/HEAD with body or bodyFile throws', async () => {
		const reader = new FakeBodyFileReader({ 'data.json': { size: 5 } });
		const builder = new RequestBuilder(reader);
		const getOp = postOperation({ method: 'get', operationId: 'getPet' });
		await assert.rejects(
			() => builder.build(registration('https://api.example.com'), getOp, { body: { a: 1 } }),
			(err: unknown) => {
				assert.ok(err instanceof RequestBuildError);
				assert.match((err as Error).message, /must not include a request body/i);
				return true;
			}
		);
		await assert.rejects(
			() => builder.build(registration('https://api.example.com'), getOp, { bodyFile: 'data.json' }),
			RequestBuildError
		);
		const headOp = postOperation({ method: 'head', operationId: 'headPet' });
		await assert.rejects(
			() => builder.build(registration('https://api.example.com'), headOp, { bodyFile: 'data.json' }),
			RequestBuildError
		);
	});

	test('empty-string required body counts as missing', async () => {
		const op = postOperation({ requestBody: { required: true, content: { 'application/json': {} } } });
		const reader = new FakeBodyFileReader({ 'data.json': { size: 5 } });
		const builder = new RequestBuilder(reader);
		await assert.rejects(
			() => builder.build(registration('https://api.example.com'), op, { body: '' }),
			(err: unknown) => {
				assert.ok(err instanceof RequestBuildError);
				assert.match((err as Error).message, /Missing required request body/);
				return true;
			}
		);
		await assert.rejects(
			() => builder.build(registration('https://api.example.com'), op, { bodyFile: '' }),
			RequestBuildError
		);
	});
});
