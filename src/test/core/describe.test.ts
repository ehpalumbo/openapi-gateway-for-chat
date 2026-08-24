import * as assert from 'assert';
import { buildDescribeApi, buildDescribeOperation, buildListApis, buildListOperations } from '../../core/describe';
import { buildApiModel, buildOperationIndex } from '../../core/operations';
import { parseSpec } from '../../core/openapi';
import { ApiRegistration, SpecSource } from '../../core/types';

const SPEC = JSON.stringify({
	openapi: '3.0.3',
	info: { title: 'Things', version: '3.2.1', description: 'Thing API.' },
	paths: {
		'/things/{thingId}': {
			parameters: [{ name: 'traceId', in: 'header', schema: { type: 'string' } }],
			get: {
				tags: ['things'],
				summary: 'Fetch a thing.',
				description: 'Longer text.',
				parameters: [
					{ name: 'thingId', in: 'path', required: true, schema: { $ref: '#/components/schemas/ThingId' } },
					{ name: 'expand', in: 'query', schema: { type: 'boolean' } },
				],
				responses: {
					'200': {
						description: 'OK.',
						content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } },
					},
				},
			},
			post: {
				tags: ['things'],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { $ref: '#/components/schemas/NewThing' } } },
				},
				responses: { '201': { description: 'Created.' } },
			},
		},
		'/other': {
			get: {
				tags: ['other'],
				responses: {
					'200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Unrelated' } } } },
				},
			},
		},
	},
	components: {
		schemas: {
			ThingId: { type: 'string' },
			Thing: { type: 'object', properties: { id: { $ref: '#/components/schemas/ThingId' }, name: { type: 'string' } } },
			NewThing: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
			Unrelated: { type: 'integer' },
		},
	},
});

function registration(): ApiRegistration {
	const document = parseSpec(SPEC);
	return {
		apiId: 'things',
		title: document.info.title,
		version: document.info.version,
		baseUrl: 'https://things.example.com',
		source: { kind: 'file', fsPath: 'things.json' } as SpecSource,
		snapshot: { document, model: buildApiModel(document) },
	};
}

suite('Description builders', () => {
	const api = registration();
	// The registry derives this once per mutation; builders must never rebuild it.
	const index = buildOperationIndex(api.snapshot.model);

	test('buildListApis summarizes each registration', () => {
		assert.deepStrictEqual(buildListApis([api]), [
			{ apiId: 'things', title: 'Things', version: '3.2.1', description: 'Thing API.' },
		]);
	});

	test('buildDescribeApi exposes groups with counts and tag descriptions', () => {
		const result = buildDescribeApi(api);
		assert.strictEqual(result.apiId, 'things');
		assert.deepStrictEqual(result.groups.map((g) => [g.name, g.operationCount]).sort(), [
			['other', 1],
			['things', 2],
		]);
	});

	test('buildListOperations returns operations of known groups', () => {
		const result = buildListOperations(api, ['things']);
		assert.ok('operations' in result);
		if (!('operations' in result)) {
			return assert.fail('expected operations');
		}
		assert.deepStrictEqual(
			result.operations.map((op) => op.operationId).sort(),
			['things-get-things', 'things-post-things']
		);
		assert.ok(
			result.operations.some((op) => op.operationId === 'things-get-things' && op.requiredParameters.includes('thingId (path)'))
		);
	});

	test('buildListOperations errors on unknown groups listing valid alternatives', () => {
		const result = buildListOperations(api, ['nope']);
		assert.deepStrictEqual(result, {
			error: 'Unknown group(s): nope. API "things" has these groups: other, things.',
			availableGroups: ['other', 'things'],
		});
		assert.deepStrictEqual(buildListOperations(api, []), {
			error: 'No group names provided. API "things" has these groups: other, things.',
			availableGroups: ['other', 'things'],
		});
	});

	test('buildDescribeOperation returns self-contained detail with exact closure', () => {
		const result = buildDescribeOperation(api, index, 'things-get-things');
		assert.ok(!('error' in result));
		if ('error' in result) {
			return assert.fail('expected operation detail');
		}
		assert.strictEqual(result.method, 'get');
		assert.strictEqual(result.pathTemplate, '/things/{thingId}');
		assert.ok(result.parameters.some((param) => param.name === 'traceId' && param.in === 'header'));
		assert.deepStrictEqual(
			result.schemas.map((entry) => entry.name).sort(),
			['Thing', 'ThingId']
		);
		assert.ok(!result.schemas.some((entry) => entry.name === 'Unrelated'));
		assert.deepStrictEqual(result.responses[0].statusCode, '200');
	});

	test('describe_operation closure covers request-body refs too', () => {
		const result = buildDescribeOperation(api, index, 'things-post-things');
		assert.ok(!('error' in result));
		if ('error' in result) {
			return assert.fail('expected operation detail');
		}
		assert.strictEqual(result.requestBody?.required, true);
		assert.deepStrictEqual(result.schemas.map((entry) => entry.name), ['NewThing']);
	});

	test('buildDescribeOperation errors on unknown IDs listing valid IDs', () => {
		const result = buildDescribeOperation(api, index, 'bogus');
		assert.ok('error' in result && /Valid IDs/.test(result.error));
		if (!('error' in result)) {
			return;
		}
		assert.deepStrictEqual([...result.availableOperationIds].sort(), ['other-get-other', 'things-get-things', 'things-post-things']);
	});

	test('all builder outputs survive a JSON round-trip', () => {
		for (const value of [
			buildListApis([api]),
			buildDescribeApi(api),
			buildListOperations(api, ['things']),
			buildDescribeOperation(api, index, 'things-get-things'),
		]) {
			assert.deepStrictEqual(JSON.parse(JSON.stringify(value)), value);
		}
	});
});
