import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseSpec, SpecError } from '../core/openapi';
import { ApiRegistration, SpecSource } from '../core/types';
import { ApiRegistry } from '../store/registry';
import { TokenStore } from '../store/secrets';
import {
	createRegistration,
	loadSpecFromSource,
	resolveBaseUrlSuggestion,
	slugifyTitle,
} from '../vscode/commands/common';
import { CommandContext, refreshAll } from '../vscode/commands/index';
import { fetchWithLimit, ProtocolNotAllowedError, SizeLimitExceededError } from '../vscode/http';

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
		const memento = new FakeMemento();
		const registry = new ApiRegistry(memento);
		const text = await loadSpecFromSource({ kind: 'url', url: specServer.url('/petstore30.json') });
		const source: SpecSource = { kind: 'url', url: specServer.url('/petstore30.json') };
		const registration = createRegistration(text, 'petstore', 'https://petstore.example.com/v1', source);

		assert.strictEqual(registration.title, 'Petstore');
		assert.strictEqual(registration.version, '1.0.0');
		const upsert = registry.upsert(registration);
		assert.strictEqual(upsert.status, 'created');
		assert.strictEqual(registry.getEntry('petstore')?.index.size, 4);

		const fresh = new ApiRegistry(memento);
		const persisted = fresh.get('petstore');
		assert.ok(persisted, 'registration should survive a fresh registry bound to the same memento');
		const freshEntry = fresh.getEntry('petstore');
		assert.ok(freshEntry);
		assert.strictEqual(freshEntry.index.size, 4);
		for (const [operationId] of freshEntry.index) {
			assert.ok(freshEntry.model.groups.some((group) => group.operations.some((op) => op.operationId === operationId)));
		}
	});

	test('upsert with an existing apiId returns a conflict without mutating state', () => {
		const memento = new FakeMemento();
		const registry = new ApiRegistry(memento);
		const text = readFixture('petstore30.json');
		const first = createRegistration(text, 'dupe', 'https://a.example.com', { kind: 'file', fsPath: 'a.json' });
		const second = createRegistration(text, 'dupe', 'https://b.example.com', { kind: 'file', fsPath: 'b.json' });

		assert.strictEqual(registry.upsert(first).status, 'created');
		const conflict = registry.upsert(second);
		assert.strictEqual(conflict.status, 'conflict');
		assert.deepStrictEqual([registry.list().length, registry.get('dupe')?.baseUrl], [1, 'https://a.example.com']);
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
		const registry = new ApiRegistry(new FakeMemento());
		const tokens = new TokenStore(new FakeSecretStorage());
		const ctx: CommandContext = { registry, tokens, onChange: () => undefined };

		const petstoreUrl = specServer.url('/petstore30.json');
		const updatedText = readFixture('petstore30.json').replace('"version": "1.0.0"', '"version": "9.9.9"');
		const okReg: ApiRegistration = createRegistration(readFixture('petstore30.json'), 'ok-api', 'https://ok.example.com', {
			kind: 'url',
			url: petstoreUrl,
		});
		const deadReg: ApiRegistration = createRegistration(readFixture('petstore30.json'), 'dead-api', 'https://dead.example.com', {
			kind: 'file',
			fsPath: path.join(FIXTURES, 'does-not-exist.json'),
		});
		registry.upsert(okReg);
		registry.upsert(deadReg);

		const failures = await refreshAll(ctx, async (source) => {
			if (source.kind === 'file') {
				throw new Error(`cannot read ${source.fsPath}`);
			}
			return updatedText;
		});

		assert.deepStrictEqual(failures.map((f) => f.split(':')[0]), ['dead-api']);
		assert.strictEqual(registry.get('dead-api')?.snapshot.document.info.version, '1.0.0');
		assert.strictEqual(registry.get('ok-api')?.snapshot.document.info.version, '9.9.9');
	});

	test('TokenStore round-trips under the apiId key scheme only', async () => {
		const secrets = new FakeSecretStorage();
		const tokens = new TokenStore(secrets);
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
