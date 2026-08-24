import * as assert from 'assert';
import { SchemaResolutionError, collectSchemaRefs, resolveSchemaClosure, resolveSchemaClosures } from '../../core/schema-resolver';
import { JsonSchema, SchemaRegistry } from '../../core/types';

const REGISTRY: SchemaRegistry = {
	Leaf: { type: 'string' },
	Mid: { type: 'object', properties: { leaf: { $ref: '#/components/schemas/Leaf' } } },
	Root: {
		type: 'object',
		properties: {
			mid: { $ref: '#/components/schemas/Mid' },
			others: { type: 'array', items: { $ref: '#/components/schemas/Mid' } },
		},
	},
	SelfRef: { type: 'object', properties: { child: { $ref: '#/components/schemas/SelfRef' } } },
	Left: { type: 'object', properties: { right: { $ref: '#/components/schemas/Right' } } },
	Right: { type: 'object', properties: { left: { $ref: '#/components/schemas/Left' } } },
	Decoy: { type: 'integer' },
} satisfies Record<string, JsonSchema>;

suite('Schema resolver', () => {
	test('collects nested refs transitively in encounter order', () => {
		const closure = resolveSchemaClosure(REGISTRY, '#/components/schemas/Root');
		assert.deepStrictEqual(
			closure.map((entry) => entry.name),
			['Root', 'Mid', 'Leaf']
		);
		assert.deepStrictEqual(closure[2].schema, REGISTRY['Leaf']);
	});

	test('excludes unrelated components (decoy stays out of the closure)', () => {
		const names = resolveSchemaClosure(REGISTRY, '#/components/schemas/Root').map((entry) => entry.name);
		assert.ok(!names.includes('Decoy'));
		assert.ok(!names.includes('SelfRef'));
		assert.ok(!names.includes('Widget'));
	});

	test('self-referencing schemas terminate', () => {
		const closure = resolveSchemaClosure(REGISTRY, '#/components/schemas/SelfRef');
		assert.deepStrictEqual(closure.map((entry) => entry.name), ['SelfRef']);
	});

	test('mutually recursive schemas terminate and include both sides', () => {
		const closure = resolveSchemaClosures(REGISTRY, [
			'#/components/schemas/Left',
			'#/components/schemas/Right',
		]);
		assert.deepStrictEqual(closure.map((entry) => entry.name), ['Left', 'Right']);
	});

	test('multi-root closures deduplicate shared components', () => {
		const closure = resolveSchemaClosures(REGISTRY, ['#/components/schemas/Mid', '#/components/schemas/Root']);
		assert.deepStrictEqual(
			closure.map((entry) => entry.name),
			['Mid', 'Leaf', 'Root']
		);
	});

	test('unknown component produces a descriptive error naming it', () => {
		assert.throws(
			() => resolveSchemaClosure(REGISTRY, '#/components/schemas/Ghost'),
			(err: unknown) =>
				err instanceof SchemaResolutionError && /Ghost/.test(err.message) && /schema registry/.test(err.message)
		);
	});

	test('non-local refs are rejected as roots but ignored when nested', () => {
		assert.throws(
			() => resolveSchemaClosure(REGISTRY, 'http://example.com/schemas/External.json'),
			SchemaResolutionError
		);
		assert.deepStrictEqual(collectSchemaRefs({ a: { $ref: 'http://example.com/x.json' }, b: { $ref: '#/components/schemas/Leaf' } }), [
			'#/components/schemas/Leaf',
		]);
	});
});
