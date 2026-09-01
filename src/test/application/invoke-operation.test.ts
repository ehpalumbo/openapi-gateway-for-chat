import * as assert from 'assert';
import {
	ApiRegistry,
	HttpClient,
	HttpRequest,
	HttpResponsePayload,
	InvokeOperationUseCase,
	RawHttpResponse,
	TokenStore,
} from '../../application';
import { ApiRegistration, OperationInfo } from '../../domain';

function registration(baseUrl = 'https://api.example.com/v1'): ApiRegistration {
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
		parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }],
		responses: {},
		...overrides,
	};
}

class FakeTokenStore implements TokenStore {
	private readonly tokens = new Map<string, string>();
	constructor(initial?: Record<string, string>) {
		if (initial) {
			for (const [k, v] of Object.entries(initial)) {
				this.tokens.set(k, v);
			}
		}
	}
	async setToken(apiId: string, token: string): Promise<void> {
		this.tokens.set(apiId, token);
	}
	async deleteToken(apiId: string): Promise<void> {
		this.tokens.delete(apiId);
	}
	async getToken(apiId: string): Promise<string | undefined> {
		return this.tokens.get(apiId);
	}
}

class FakeRegistry implements ApiRegistry {
	private readonly regList: ApiRegistration[] = [];
	constructor(regs: ApiRegistration[] = []) {
		this.regList = [...regs];
	}
	async upsert() { return { status: 'created' as const }; }
	async replaceSnapshot() { return true; }
	async remove() { return true; }
	list() { return this.regList.map((r) => ({ apiId: r.apiId, title: r.title, version: r.version, baseUrl: r.baseUrl, source: r.source, description: r.snapshot.model.info.description })); }
	has(apiId: string) { return this.regList.some((r) => r.apiId === apiId); }
	async get(apiId: string) { return this.regList.find((r) => r.apiId === apiId); }
	async getEntry(apiId: string) {
		const reg = await this.get(apiId);
		return reg ? { registration: reg, model: reg.snapshot.model, index: new Map([[operation().operationId, operation()]]) } : undefined;
	}
}

class FakeHttpClient implements HttpClient {
	handler?: (request: HttpRequest) => Promise<RawHttpResponse>;
	async send(request: HttpRequest): Promise<RawHttpResponse> {
		if (!this.handler) {
			throw new Error('No handler set in FakeHttpClient');
		}
		return this.handler(request);
	}
}

function jsonRawResponse(status: number, body: string, contentType = 'application/json'): RawHttpResponse {
	return {
		status,
		statusText: status === 200 ? 'OK' : '',
		headers: { 'content-type': contentType },
		body: new TextEncoder().encode(body),
	};
}

suite('InvokeOperationUseCase', () => {

	test('performs the built request and returns a classified response payload', async () => {
		const client = new FakeHttpClient();
		let seenRequest: HttpRequest | undefined;
		client.handler = async (req) => {
			seenRequest = req;
			return jsonRawResponse(200, '{"id":1}');
		};

		const useCase = new InvokeOperationUseCase(new FakeRegistry(), new FakeTokenStore(), client);
		const result = await useCase.execute(registration(), operation(), {
			apiId: 'petshop',
			operationId: 'getPetById',
			pathParams: { petId: 42 },
		});

		assert.strictEqual(result.kind, 'response');
		const payload = result as HttpResponsePayload;
		assert.strictEqual(payload.status, 200);
		assert.strictEqual(seenRequest?.url, 'https://api.example.com/v1/pets/42');
		assert.strictEqual(seenRequest?.method, 'GET');
		assert.strictEqual(payload.headers['content-type'], 'application/json');
		assert.deepStrictEqual(payload.body, { class: 'text', text: '{"id":1}' });
	});

	test('attaches a stored token as Bearer auth', async () => {
		const client = new FakeHttpClient();
		let authHeader: string | undefined;
		client.handler = async (req) => {
			authHeader = req.headers.Authorization;
			return jsonRawResponse(200, '{}');
		};

		const tokenStore = new FakeTokenStore({ petshop: 's3cr3t' });
		const useCase = new InvokeOperationUseCase(new FakeRegistry(), tokenStore, client);
		await useCase.execute(registration(), operation(), {
			apiId: 'petshop',
			operationId: 'getPetById',
			pathParams: { petId: 1 },
		});

		assert.strictEqual(authHeader, 'Bearer s3cr3t');
	});

	test('no token is attached when the store returns undefined', async () => {
		const client = new FakeHttpClient();
		let authHeader: unknown = 'unset';
		client.handler = async (req) => {
			authHeader = req.headers.Authorization;
			return jsonRawResponse(200, '{}');
		};

		const useCase = new InvokeOperationUseCase(new FakeRegistry(), new FakeTokenStore(), client);
		await useCase.execute(registration(), operation(), {
			apiId: 'petshop',
			operationId: 'getPetById',
			pathParams: { petId: 1 },
		});

		assert.strictEqual(authHeader, undefined);
	});

	test('validation failures return a build outcome without any network traffic', async () => {
		const client = new FakeHttpClient();
		let called = false;
		client.handler = async () => {
			called = true;
			return jsonRawResponse(200, '{}');
		};

		const useCase = new InvokeOperationUseCase(new FakeRegistry(), new FakeTokenStore(), client);
		const result = await useCase.execute(registration(), operation(), {
			apiId: 'petshop',
			operationId: 'getPetById',
		});

		assert.strictEqual(result.kind, 'build');
		assert.match((result as { error: string }).error, /petId/i);
		assert.strictEqual(called, false, 'no request should reach the network');
	});

	test('image content is returned as a raw image payload', async () => {
		const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const client = new FakeHttpClient();
		client.handler = async () => ({
			status: 200,
			statusText: 'OK',
			headers: { 'content-type': 'image/png' },
			body: png,
		});

		const useCase = new InvokeOperationUseCase(new FakeRegistry(), new FakeTokenStore(), client);
		const result = await useCase.execute(registration(), operation(), {
			apiId: 'petshop',
			operationId: 'getPetById',
			pathParams: { petId: 1 },
		});

		assert.strictEqual(result.kind, 'response');
		const body = (result as HttpResponsePayload).body!!;
		assert.strictEqual(body.class, 'image');
		assert.strictEqual((body as { mimeType: string }).mimeType, 'image/png');
		assert.deepStrictEqual(Array.from((body as { bytes: Uint8Array }).bytes), Array.from(png));
	});

	test('an empty body is returned as undefined', async () => {
		const client = new FakeHttpClient();
		client.handler = async () => ({
			status: 204,
			statusText: 'No Content',
			headers: {},
			body: new Uint8Array(0),
		});

		const useCase = new InvokeOperationUseCase(new FakeRegistry(), new FakeTokenStore(), client);
		const result = await useCase.execute(registration(), operation(), {
			apiId: 'petshop',
			operationId: 'getPetById',
			pathParams: { petId: 1 },
		});

		assert.strictEqual(result.kind, 'response');
		assert.strictEqual((result as HttpResponsePayload).body, undefined);
	});

	test('non-text non-image content classifies as binary', async () => {
		const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46]);
		const client = new FakeHttpClient();
		client.handler = async () => ({
			status: 200,
			statusText: 'OK',
			headers: { 'content-type': 'application/pdf' },
			body: pdf,
		});

		const useCase = new InvokeOperationUseCase(new FakeRegistry(), new FakeTokenStore(), client);
		const result = await useCase.execute(registration(), operation(), {
			apiId: 'petshop',
			operationId: 'getPetById',
			pathParams: { petId: 1 },
		});

		assert.strictEqual(result.kind, 'response');
		const body = (result as HttpResponsePayload).body!!;
		assert.strictEqual(body.class, 'binary');
		assert.strictEqual((body as { mimeType: string }).mimeType, 'application/pdf');
	});

	test('transport failures return a network outcome with a retry hint', async () => {
		const client = new FakeHttpClient();
		client.handler = async () => {
			throw new TypeError('fetch failed');
		};

		const useCase = new InvokeOperationUseCase(new FakeRegistry(), new FakeTokenStore(), client);
		const result = await useCase.execute(registration(), operation(), {
			apiId: 'petshop',
			operationId: 'getPetById',
			pathParams: { petId: 1 },
		});

		assert.strictEqual(result.kind, 'network');
		const network = result as { message: string; url: string };
		assert.match(network.message, /Network request failed/);
		assert.strictEqual(network.url, 'https://api.example.com/v1/pets/1');
	});
});

