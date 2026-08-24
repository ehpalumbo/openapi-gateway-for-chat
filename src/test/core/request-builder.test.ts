import * as assert from 'assert';
import { buildRequest, InvokeInput, RequestBuildError } from '../../core/request-builder';
import { ApiRegistration, OperationInfo } from '../../core/types';

function registration(baseUrl: string): ApiRegistration {
	return {
		apiId: 'petshop',
		title: 'Petshop',
		version: '1.0.0',
		baseUrl,
		source: { kind: 'url', url: 'https://spec.example.com/petshop.json' },
		snapshot: {
			document: { openapi: '3.0.3', info: { title: 'Petshop', version: '1.0.0' }, paths: {} },
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

suite('Request builder', () => {
	test('substitutes path params into the template against the base URL', () => {
		const request = buildRequest(registration('https://api.example.com/v1'), operation(), {
			pathParams: { petId: 42 },
		});
		assert.strictEqual(request.method, 'GET');
		assert.strictEqual(request.url, 'https://api.example.com/v1/pets/42');
	});

	test('normalizes trailing slashes between the base URL and path template', () => {
		const slashed = buildRequest(registration('https://api.example.com/v1/'), operation(), {
			pathParams: { petId: 42 },
		});
		const bare = buildRequest(registration('https://api.example.com'), operation(), {
			pathParams: { petId: 42 },
		});
		assert.strictEqual(slashed.url, 'https://api.example.com/v1/pets/42');
		assert.strictEqual(bare.url, 'https://api.example.com/pets/42');
	});

	test('missing required path params fail fast enumerating exactly which are required', () => {
		const op = operation({
			pathTemplate: '/pets/{petId}/toys/{toyId}',
			parameters: [
				{ name: 'petId', in: 'path', required: true },
				{ name: 'toyId', in: 'path', required: true },
				{ name: 'verbose', in: 'query', required: false },
			],
		});
		assert.throws(
			() => buildRequest(registration('https://api.example.com/v1'), op, {}),
			(error: unknown) => {
				assert.ok(error instanceof RequestBuildError);
				assert.match(error.message, /petId, toyId/);
				return true;
			}
		);
	});

	test('empty-string path param counts as missing', () => {
		assert.throws(() => buildRequest(registration('https://api.example.com/v1'), operation(), {
			pathParams: { petId: '' },
		}), RequestBuildError);
	});

	test('path values are encoded so they cannot alter the target origin', () => {
		const request = buildRequest(registration('https://api.example.com/v1'), operation(), {
			pathParams: { petId: '../admin#x' },
		});
		assert.strictEqual(request.url, 'https://api.example.com/v1/pets/..%2Fadmin%23x');
	});

	test('array query params render as repeated keys and booleans as lowercase', () => {
		const request = buildRequest(registration('https://api.example.com/v1'), operation(), {
			pathParams: { petId: 7 },
			queryParams: { verbose: true, tags: ['cute', 'brown'] },
		});
		const url = new URL(request.url);
		assert.strictEqual(url.searchParams.getAll('tags').join(','), 'cute,brown');
		assert.strictEqual(url.searchParams.get('verbose'), 'true');
	});

	test('number query params serialize plainly and null values are dropped', () => {
		const op = operation({
			pathTemplate: '/pets',
			parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }],
		});
		const request = buildRequest(registration('https://api.example.com/v1'), op, {
			queryParams: { limit: 10, skip: null },
		});
		assert.strictEqual(request.url, 'https://api.example.com/v1/pets?limit=10');
	});

	test('user headers merge under spec-declared header parameters', () => {
		const request = buildRequest(registration('https://api.example.com/v1'), operation(), {
			pathParams: { petId: 1 },
			headers: { Accept: 'application/xml' },
		});
		assert.strictEqual(request.headers['X-Trace-Id'], undefined);
		assert.strictEqual(request.headers.Accept, 'application/xml');
	});

	test('header params declared by the spec are sent when provided via headers input', () => {
		const request = buildRequest(registration('https://api.example.com/v1'), operation(), {
			pathParams: { petId: 1 },
			queryParams: {},
			headers: { 'X-Trace-Id': 'abc-123' },
		});
		assert.strictEqual(request.headers['X-Trace-Id'], 'abc-123');
	});

	test('rejects attempts to override Host or Authorization via header injection', () => {
		for (const name of ['Host', 'host', 'HOST', 'Authorization']) {
			assert.throws(
				() =>
					buildRequest(registration('https://api.example.com/v1'), operation(), {
						pathParams: { petId: 1 },
						headers: { [name]: 'https://evil.example.com' },
					}),
				RequestBuildError,
				`expected ${name} to be rejected`
			);
		}
	});

	test('body passes through as JSON with a Content-Type header when supplied', () => {
		const op = operation({
			method: 'post',
			pathTemplate: '/pets',
			parameters: [],
			requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
		});
		const request = buildRequest(registration('https://api.example.com/v1'), op, {
			body: { name: 'Rex' },
		} satisfies InvokeInput & { body?: unknown });
		assert.strictEqual(request.method, 'POST');
		assert.strictEqual(request.body, '{"name":"Rex"}');
		assert.strictEqual(request.headers['Content-Type'], 'application/json');
	});

	test('no body is set when the caller supplies none', () => {
		const request = buildRequest(registration('https://api.example.com/v1'), operation(), {
			pathParams: { petId: 1 },
		});
		assert.strictEqual(request.body, undefined);
		assert.strictEqual('Content-Type' in request.headers, false);
	});
});
