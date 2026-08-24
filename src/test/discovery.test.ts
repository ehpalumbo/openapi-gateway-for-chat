import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseSpec } from '../core/openapi';
import { buildApiModel } from '../core/operations';
import { ApiRegistration } from '../core/types';
import { ApiRegistry } from '../store/registry';
import { registerGatewayTools } from '../vscode/tools';

/** The four read-only discovery tools contributed in package.json. */
const DISCOVERY_TOOL_NAMES = [
	'gateway_list_apis',
	'gateway_describe_api',
	'gateway_list_operations',
	'gateway_describe_operation',
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

function catalogRegistration(apiId: string): ApiRegistration {
	const document = parseSpec(readFixture('catalog30.json'));
	return {
		apiId,
		title: document.info.title,
		version: document.info.version,
		baseUrl: 'https://catalog.example.com/v2',
		source: { kind: 'file', fsPath: path.join(FIXTURES, 'catalog30.json') },
		snapshot: { document, model: buildApiModel(document) },
	};
}

async function invoke(name: string, input: Record<string, unknown>): Promise<unknown> {
	const result = await vscode.lm.invokeTool(
		name,
		{ input, toolInvocationToken: undefined },
		new vscode.CancellationTokenSource().token
	);
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
	let registry: ApiRegistry;
	let refresh: () => void;

	suiteSetup(() => {
		registry = new ApiRegistry(new FakeMemento());
		refresh = registerGatewayTools(registry).refresh;
	});

	test('all four gateway_* tools are listed in vscode.lm.tools once registered', () => {
		for (const name of DISCOVERY_TOOL_NAMES) {
			assert.ok(vscode.lm.tools.some((tool) => tool.name === name), `${name} should be listed`);
		}
	});

	test('with an empty registry, tools return a descriptive error result instead of throwing', async () => {
		const payload = (await invoke('gateway_list_apis', {})) as { error?: string };
		assert.match(payload.error ?? '', /No APIs registered/);
	});

	test('the progressive disclosure chain works end-to-end on the fixture', async () => {
		registry.upsert(catalogRegistration('catalog'));
		registry.upsert(catalogRegistration('mirror'));
		refresh();

		const listed = (await invoke('gateway_list_apis', {})) as { apis: { apiId: string; title: string }[] };
		assert.deepStrictEqual(
			listed.apis.map((api) => [api.apiId, api.title]),
			[
				['catalog', 'Catalog'],
				['mirror', 'Catalog'],
			]
		);

		const described = (await invoke('gateway_describe_api', { apiId: 'catalog' })) as {
			groups: { name: string; operationCount: number }[];
		};
		assert.deepStrictEqual(
			described.groups.map((group) => [group.name, group.operationCount]),
			[
				['admin', 1],
				['items', 1],
			]
		);

		const operations = (await invoke('gateway_list_operations', { apiId: 'catalog', groups: ['items'] })) as {
			operations: { operationId: string }[];
		};
		assert.deepStrictEqual(operations.operations.map((op) => op.operationId), ['createItem']);

		const detail = (await invoke('gateway_describe_operation', {
			apiId: 'catalog',
			operationId: 'createItem',
		})) as { schemas: { name: string }[] };
		assert.deepStrictEqual(
			detail.schemas.map((entry) => entry.name).sort(),
			['AttributeMap', 'Item', 'NewItem', 'Tag', 'Variant']
		);
	});

	test('describe_operation excludes the decoy schema unreachable from the operation', async () => {
		const detail = (await invoke('gateway_describe_operation', {
			apiId: 'catalog',
			operationId: 'createItem',
		})) as { schemas: { name: string }[] };
		const names = detail.schemas.map((entry) => entry.name);
		for (const unreachable of ['Widget', 'Node', 'Left', 'Right']) {
			assert.ok(!names.includes(unreachable), `${unreachable} must not leak into the closure`);
		}
	});

	test('unknown group errors enumerate the valid group names', async () => {
		const payload = (await invoke('gateway_list_operations', { apiId: 'catalog', groups: ['nope'] })) as {
			error: string;
			availableGroups: string[];
		};
		assert.match(payload.error, /Unknown group\(s\): nope/);
		assert.deepStrictEqual(payload.availableGroups, ['admin', 'items']);
	});

	test('after unregistering, refreshed tools report the empty-registry error instead of throwing', async () => {
		registry.remove('catalog');
		registry.remove('mirror');
		refresh();

		const listed = (await invoke('gateway_list_apis', {})) as { error?: string };
		assert.match(listed.error ?? '', /No APIs registered/);

		const described = (await invoke('gateway_describe_api', { apiId: 'catalog' })) as { error?: string };
		assert.match(described.error ?? '', /No APIs registered/);
	});
});
