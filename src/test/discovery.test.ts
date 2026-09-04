import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DiscoveryUseCases, InvokeOperationUseCase, TokenStore } from '../application';
import { ApiRegistration, buildApiModel, parseSpec, RequestBuilder, RequestBuildError } from '../domain';
import {
	createDescribeApiTool,
	createDescribeOperationTool,
	createListApisTool,
	createListOperationsTool,
	FetchHttpClient,
	FileBackedApiRegistry,
	registerGatewayTools,
	ToolContext,
} from '../infrastructure';

/** The four read-only discovery tools contributed in package.json. */
const DISCOVERY_TOOL_NAMES = [
	'gateway_list_apis',
	'gateway_describe_api',
	'gateway_list_api_operations',
	'gateway_describe_api_operation',
] as const;

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

const noTokens: TokenStore = {
	getToken: () => Promise.resolve(undefined),
	setToken: () => Promise.resolve(),
	deleteToken: () => Promise.resolve(),
};

/** Discovery tools never spill; a stub keeps the required context shape. */
const noSpills = {
	write: async (fileName: string): Promise<string> => `/tmp/fake-spills/${fileName}`,
	cleanup: async (): Promise<void> => undefined,
};

function catalogRegistration(apiId: string): ApiRegistration {
	const document = parseSpec(readFixture('catalog30.json'));
	const model = buildApiModel(document);
	return {
		apiId,
		title: document.info.title,
		version: document.info.version,
		baseUrl: 'https://catalog.example.com/v2',
		source: { kind: 'file', fsPath: path.join(FIXTURES, 'catalog30.json') },
		snapshot: { model },
	};
}

async function invoke(tool: vscode.LanguageModelTool<unknown>, input: Record<string, unknown>): Promise<unknown> {
	const result = await tool.invoke(
		{ input, toolInvocationToken: undefined },
		new vscode.CancellationTokenSource().token
	);
	assert.ok(result, 'expected a tool result');
	const part = result.content[0];
	assert.ok(part instanceof vscode.LanguageModelTextPart, `expected a single text part`);
	return JSON.parse((part as vscode.LanguageModelTextPart).value);
}

/**
 * Drives the four discovery tools against an in-memory registry seeded from a
 * local fixture. No HTTP server is started anywhere in this suite: every tool
 * response must come purely from the registry snapshot (NFR-4).
 */
suite('Discovery flow', () => {
	let registry: FileBackedApiRegistry;
	let registryStorageDir: string;
	let context: ToolContext;
	let listApisTool: vscode.LanguageModelTool<unknown>;
	let describeApiTool: vscode.LanguageModelTool<unknown>;
	let listOperationsTool: vscode.LanguageModelTool<unknown>;
	let describeOperationTool: vscode.LanguageModelTool<unknown>;

	suiteSetup(async () => {
		registryStorageDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openapi-gateway-registry-'));
		registry = new FileBackedApiRegistry(new FakeMemento(), vscode.Uri.file(registryStorageDir));
		const discoveryUseCases = new DiscoveryUseCases(registry);
		const noopReader = {
			async stat(llmPath: string) { throw new RequestBuildError(`unexpected stat for "${llmPath}"`); },
			async read(llmPath: string) { throw new RequestBuildError(`unexpected read for "${llmPath}"`); },
		};
		const invokeUseCase = new InvokeOperationUseCase(registry, noTokens, new FetchHttpClient(), new RequestBuilder(noopReader));
		context = { registry, tokens: noTokens, spills: noSpills, discoveryUseCases, invokeUseCase };
		listApisTool = createListApisTool(context);
		describeApiTool = createDescribeApiTool(context);
		listOperationsTool = createListOperationsTool(context);
		describeOperationTool = createDescribeOperationTool(context);
	});

	suiteTeardown(async () => {
		if (registryStorageDir) {
			await fs.promises.rm(registryStorageDir, { recursive: true, force: true });
		}
	});

	test('registerGatewayTools binds every contributed name in vscode.lm.tools', () => {
		const disposables = registerGatewayTools(context);
		try {
			for (const name of DISCOVERY_TOOL_NAMES) {
				assert.ok(vscode.lm.tools.some((tool) => tool.name === name), `${name} should be listed`);
			}
		} finally {
			for (const disposable of disposables) {
				disposable.dispose();
			}
		}
	});

	test('with an empty registry, tools return a descriptive error result instead of throwing', async () => {
		const payload = (await invoke(listApisTool, {})) as { error?: string };
		assert.match(payload.error ?? '', /No APIs registered/);
	});

	test('the progressive disclosure chain works end-to-end on the fixture', async () => {
		await registry.insert(catalogRegistration('catalog'));
		await registry.insert(catalogRegistration('mirror'));

		const listed = (await invoke(listApisTool, {})) as { apis: { apiId: string; title: string }[] };
		assert.deepStrictEqual(
			listed.apis.map((api) => [api.apiId, api.title]),
			[
				['catalog', 'Catalog'],
				['mirror', 'Catalog'],
			]
		);

		const described = (await invoke(describeApiTool, { apiId: 'catalog' })) as {
			groups: { name: string; operationCount: number }[];
		};
		assert.deepStrictEqual(
			described.groups.map((group) => [group.name, group.operationCount]),
			[
				['admin', 1],
				['items', 1],
			]
		);

		const operations = (await invoke(listOperationsTool, { apiId: 'catalog', groups: ['items'] })) as {
			operations: { operationId: string }[];
		};
		assert.deepStrictEqual(operations.operations.map((op) => op.operationId), ['createItem']);

		const detail = (await invoke(describeOperationTool, {
			apiId: 'catalog',
			operationId: 'createItem',
		})) as { schemas: { name: string }[] };
		assert.deepStrictEqual(
			detail.schemas.map((entry) => entry.name).sort(),
			['AttributeMap', 'Item', 'NewItem', 'Tag', 'Variant']
		);
	});

	test('describe_operation excludes the decoy schema unreachable from the operation', async () => {
		const detail = (await invoke(describeOperationTool, {
			apiId: 'catalog',
			operationId: 'createItem',
		})) as { schemas: { name: string }[] };
		const names = detail.schemas.map((entry) => entry.name);
		for (const unreachable of ['Widget', 'Node', 'Left', 'Right']) {
			assert.ok(!names.includes(unreachable), `${unreachable} must not leak into the closure`);
		}
	});

	test('unknown group returns empty operations and correction hints', async () => {
		// All-unknown: operations empty, unknownGroups set
		const unknownOnly = (await invoke(listOperationsTool, { apiId: 'catalog', groups: ['nope'] })) as {
			operations: unknown[];
			unknownGroups: string[];
			availableGroups: string[];
		};
		assert.deepStrictEqual(unknownOnly.operations, []);
		assert.deepStrictEqual(unknownOnly.unknownGroups, ['nope']);
		assert.deepStrictEqual(unknownOnly.availableGroups, ['admin', 'items']);

		// Mixed: matched operations returned alongside the correction hints
		const mixed = (await invoke(listOperationsTool, { apiId: 'catalog', groups: ['items', 'nope'] })) as {
			operations: { operationId: string }[];
			unknownGroups: string[];
			availableGroups: string[];
		};
		assert.deepStrictEqual(mixed.operations.map((op) => op.operationId), ['createItem']);
		assert.deepStrictEqual(mixed.unknownGroups, ['nope']);
		assert.deepStrictEqual(mixed.availableGroups, ['admin', 'items']);
	});

	test('after unregistering, tools report the empty-registry error instead of throwing', async () => {
		await registry.remove('catalog');
		await registry.remove('mirror');

		const listed = (await invoke(listApisTool, {})) as { error?: string };
		assert.match(listed.error ?? '', /No APIs registered/);

		const described = (await invoke(describeApiTool, { apiId: 'catalog' })) as { error?: string };
		assert.match(described.error ?? '', /No APIs registered/);
	});
});
