import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	createRegistration,
	RefreshApisUseCase,
	RegisterApiUseCase,
	resolveBaseUrlSuggestion,
	slugifyTitle,
	UnregisterApiUseCase,
} from '../application';
import { ApiRegistration, parseSpec, SpecError, SpecSource } from '../domain';
import {
	CommandContext,
	FetchSpecLoader,
	fetchWithLimit,
	FileBackedApiRegistry,
	ProtocolNotAllowedError,
	refreshAll,
	SecretTokenStore,
	SizeLimitExceededError,
} from '../infrastructure';

const FIXTURES = path.resolve(__dirname, '../../src/test/fixtures');

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

class FakeSecretStorage implements vscode.SecretStorage {
	private readonly values = new Map<string, string>();
	private readonly emitter = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();

	onDidChange = this.emitter.event;

	get(key: string): Thenable<string | undefined> {
		return Promise.resolve(this.values.get(key));
	}

	store(key: string, value: string): Thenable<void> {
		this.values.set(key, value);
		this.emitter.fire({ key });
		return Promise.resolve();
	}

	delete(key: string): Thenable<void> {
		this.values.delete(key);
		this.emitter.fire({ key });
		return Promise.resolve();
	}

	keys(): Thenable<string[]> {
		return Promise.resolve([...this.values.keys()]);
	}
}

interface TestServer {
	url(pathname: string): string;
	dispose(): Promise<void>;
}

async function createTempRegistry(memento = new FakeMemento()): Promise<{
	registry: FileBackedApiRegistry;
	memento: FakeMemento;
	dir: string;
	uri: vscode.Uri;
}> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openapi-gateway-registry-'));
	const uri = vscode.Uri.file(dir);
	const registry = new FileBackedApiRegistry(memento, uri);
	return { registry, memento, dir, uri };
}

async function startSpecServer(): Promise<TestServer> {
	const server = http.createServer((req, res) => {
		switch (req.url) {
			case '/petstore30.json':
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(readFixture('petstore30.json'));
				break;
			case '/multiserver31.json':
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(readFixture('multiserver31.json'));
				break;
			case '/swagger20.json':
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(readFixture('swagger20.json'));
				break;
			case '/huge':
				res.writeHead(200);
				res.end('x'.repeat(64 * 1024));
				break;
			default:
				res.writeHead(404);
				res.end('not found');
		}
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('failed to bind test server');
	}
	const port = address.port;
	return {
		url: (pathname: string) => `http://127.0.0.1:${port}${pathname}`,
		dispose: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

suite('Registration flows', () => {
	let specServer: TestServer;

	suiteSetup(async () => {
		specServer = await startSpecServer();
	});

	suiteTeardown(async () => {
		await specServer.dispose();
	});

	test('fetchWithLimit rejects non-http(s) protocols before any network call', async () => {
		await assert.rejects(fetchWithLimit('ftp://example.com/spec.json', 1024), ProtocolNotAllowedError);
	});

	test('fetchWithLimit aborts responses larger than the byte cap', async () => {
		await assert.rejects(
			fetchWithLimit(specServer.url('/huge'), 8192),
			(err: unknown) => err instanceof SizeLimitExceededError && /size limit of 8192 bytes/.test(err.message)
		);
	});

	test('fetchWithLimit serves fixture specs and reports the final URL', async () => {
		const { text, finalUrl } = await fetchWithLimit(specServer.url('/petstore30.json'), 1024 * 1024);
		assert.strictEqual(finalUrl, specServer.url('/petstore30.json'));
		assert.ok(/"openapi":\s*"3\.0\.3"/.test(text));
	});

	test('URL registration end-to-end persists and is visible to a fresh registry over the same state', async () => {
		const { registry, memento, dir, uri } = await createTempRegistry();
		try {
			const specLoader = new FetchSpecLoader();
			const text = await specLoader.load({ kind: 'url', url: specServer.url('/petstore30.json') });
			const source: SpecSource = { kind: 'url', url: specServer.url('/petstore30.json') };
			const registration = createRegistration(text, 'petstore', 'https://petstore.example.com/v1', source);

			assert.strictEqual(registration.title, 'Petstore');
			assert.strictEqual(registration.version, '1.0.0');
			const inserted = await registry.insert(registration);
			assert.strictEqual(inserted.status, 'created');
			assert.strictEqual((await registry.getEntry('petstore'))?.index.size, 4);

			const fresh = new FileBackedApiRegistry(memento, uri);
			const persisted = await fresh.get('petstore');
			assert.ok(persisted, 'registration should survive a fresh registry bound to the same memento');
			const freshEntry = await fresh.getEntry('petstore');
			assert.ok(freshEntry);
			assert.strictEqual(freshEntry.index.size, 4);
			for (const [operationId] of freshEntry.index) {
				assert.ok(freshEntry.model.groups.some((group) => group.operations.some((op) => op.operationId === operationId)));
			}
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test('insert with an existing apiId returns a conflict without mutating state', async () => {
		const { registry, dir } = await createTempRegistry();
		try {
			const text = readFixture('petstore30.json');
			const first = createRegistration(text, 'dupe', 'https://a.example.com', { kind: 'file', fsPath: 'a.json' });
			const second = createRegistration(text, 'dupe', 'https://b.example.com', { kind: 'file', fsPath: 'b.json' });

			assert.strictEqual((await registry.insert(first)).status, 'created');
			const conflict = await registry.insert(second);
			assert.strictEqual(conflict.status, 'conflict');
			const dupe = await registry.get('dupe');
			assert.deepStrictEqual([registry.list().length, dupe?.baseUrl], [1, 'https://a.example.com']);
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test('Swagger 2.0 documents are rejected with an actionable message', () => {
		assert.throws(() => parseSpec(readFixture('swagger20.json')), (err: unknown) => err instanceof SpecError && /Swagger 2\.0/.test(err.message));
	});

	test('YAML documents are rejected with the JSON-only message', () => {
		assert.throws(
			() => parseSpec('openapi: 3.0.0\ninfo:\n  title: Yaml API\npaths: {}'),
			(err: unknown) => err instanceof SpecError && /JSON/.test(err.message)
		);
	});

	test('multi-server specs keep both servers so a picker can be shown', () => {
		const doc = parseSpec(readFixture('multiserver31.json'));
		assert.strictEqual(doc.servers?.length, 2);
	});

	test('refresh failure retention with mixed sources', async () => {
		const { registry, dir } = await createTempRegistry();
		try {
			const tokens = new SecretTokenStore(new FakeSecretStorage());
			const updatedText = readFixture('petstore30.json').replace('"version": "1.0.0"', '"version": "9.9.9"');
			const specLoader = {
				load: async (source: SpecSource) => {
					if (source.kind === 'file') {
						throw new Error(`cannot read ${source.fsPath}`);
					}
					return updatedText;
				},
			};
			const refreshUseCase = new RefreshApisUseCase(registry, specLoader);
			const ctx: CommandContext = {
				registry,
				tokens,
				specLoader,
				registerUseCase: new RegisterApiUseCase(registry, tokens),
				unregisterUseCase: new UnregisterApiUseCase(registry, tokens),
				refreshUseCase,
				onChange: () => undefined,
			};

			const petstoreUrl = specServer.url('/petstore30.json');
			const okReg: ApiRegistration = createRegistration(readFixture('petstore30.json'), 'ok-api', 'https://ok.example.com', {
				kind: 'url',
				url: petstoreUrl,
			});
			const deadReg: ApiRegistration = createRegistration(readFixture('petstore30.json'), 'dead-api', 'https://dead.example.com', {
				kind: 'file',
				fsPath: path.join(FIXTURES, 'does-not-exist.json'),
			});
			await registry.insert(okReg);
			await registry.insert(deadReg);

			const failures = await refreshAll(ctx);

			assert.deepStrictEqual(failures.map((f) => f.split(':')[0]), ['dead-api']);
			assert.strictEqual((await registry.get('dead-api'))?.snapshot.model.info.version, '1.0.0');
			assert.strictEqual((await registry.get('ok-api'))?.snapshot.model.info.version, '9.9.9');
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test('SecretTokenStore round-trips under the apiId key scheme only', async () => {
		const secrets = new FakeSecretStorage();
		const tokens = new SecretTokenStore(secrets);
		await tokens.setToken('petstore', 's3cret');
		assert.strictEqual(await tokens.getToken('petstore'), 's3cret');
		await tokens.deleteToken('petstore');
		assert.strictEqual(await tokens.getToken('petstore'), undefined);
		assert.ok([...secrets['values'].keys()].every((key) => /^apiId:/.test(key)));
	});

	test('slugifyTitle produces identifier-friendly suggestions', () => {
		assert.strictEqual(slugifyTitle('Multi Server API!'), 'multi-server-api');
	});

	test('resolveBaseUrlSuggestion falls back when the spec declares no servers', () => {
		const doc = parseSpec('{"openapi":"3.0.3","info":{"title":"No Servers","version":"1.0.0"},"paths":{}}');
		assert.strictEqual(resolveBaseUrlSuggestion(doc), 'https://api.example.com/v1');
	});

	test('resolveBaseUrlSuggestion uses the declared server so it can be confirmed or overridden (R-REG-9)', () => {
		assert.strictEqual(resolveBaseUrlSuggestion(parseSpec(readFixture('petstore30.json'))), 'https://petstore.example.com/v1');
	});

	test('resolveBaseUrlSuggestion picks the first server for multi-server specs; UI offers all via picker', () => {
		const doc = parseSpec(readFixture('multiserver31.json'));
		assert.strictEqual(doc.servers?.length, 2);
		assert.strictEqual(resolveBaseUrlSuggestion(doc), 'https://api.example.com/v2');
	});
});
