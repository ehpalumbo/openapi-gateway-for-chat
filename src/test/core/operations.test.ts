/**
 * Unit tests for operation-ID derivation and grouping (`core/operations.ts`).
 *
 * Pure Node tests: no `vscode` import, runnable via `npm run test:unit`.
 * Every rule of R-ID-1..4 and R-GRP-1 is covered by at least one assertion,
 * including the concrete example from the specification.
 */
import * as assert from 'assert';
import { OpenApiDocument } from '../../core/types';
import { buildApiModel, buildOperationIndex, buildOperations, deriveOperationId, findOperation, operationsInGroups } from '../../core/operations';

suite('core/operations', () => {
	suite('deriveOperationId', () => {
		test('spec example: first tag pets, GET /pets/{petId} -> pets-get-pets', () => {
			assert.strictEqual(deriveOperationId('pets', 'get', '/pets/{petId}'), 'pets-get-pets');
		});

		test('skips path-template variables and joins segments with dashes', () => {
			assert.strictEqual(deriveOperationId('store', 'post', '/stores/{storeId}/orders/{orderId}'), 'store-post-stores-orders');
		});

		test('converts underscores and slashes to dashes', () => {
			assert.strictEqual(deriveOperationId('admin', 'get', '/user_settings/profile'), 'admin-get-user-settings-profile');
		});

		test('lowercases the method', () => {
			assert.strictEqual(deriveOperationId('pets', 'GET', '/pets'), 'pets-get-pets');
		});
	});

	suite('buildOperations', () => {
		/**
		 * Builds a minimal valid document around the given paths.
		 *
		 * @param paths - Path items keyed by path template.
		 * @returns A document ready for {@link buildOperations}.
		 */
		function docWith(paths: OpenApiDocument['paths']): OpenApiDocument {
			return { openapi: '3.0.3', info: { title: 'T', version: '1' }, paths };
		}

		test('uses declared operationId verbatim (R-ID-1)', () => {
			const ops = buildOperations(
				docWith({
					'/pets/{petId}': { get: { operationId: 'showPetById', tags: ['pets'], parameters: [] } },
				})
			);
			assert.strictEqual(ops.length, 1);
			assert.strictEqual(ops[0].operationId, 'showPetById');
			assert.strictEqual(ops[0].declaredOperationId, true);
		});

		test('derives kebab-case id from first tag when operationId missing (R-ID-2)', () => {
			const ops = buildOperations(
				docWith({
					'/pets/{petId}': { get: { tags: ['pets'] } },
				})
			);
			assert.strictEqual(ops[0].operationId, 'pets-get-pets');
			assert.strictEqual(ops[0].declaredOperationId, false);
		});

		test('appends incrementing -2 suffix on derived-ID collisions (R-ID-3)', () => {
			const ops = buildOperations(
				docWith({
					'/pets/{id}': { get: { tags: ['pets'] } },
					'/pets/{petId}': { get: { tags: ['pets'] } },
					'/pets/{petIdOrName}': { get: { tags: ['pets'] } },
				})
			);
			const ids = ops.map((op) => op.operationId).sort();
			assert.deepStrictEqual(ids, ['pets-get-pets', 'pets-get-pets-2', 'pets-get-pets-3']);
		});

		test('untagged operations belong to the default group (R-GRP-1)', () => {
			const ops = buildOperations(
				docWith({
					'/ping': { get: {} },
				})
			);
			assert.strictEqual(ops[0].group, 'default');
			assert.strictEqual(ops[0].operationId, 'default-get-ping');
		});

		test('groups reflect the first declared tag only', () => {
			const document = docWith({
				'/pets': { get: { tags: ['pets', 'public'] } },
				'/stores': { post: { tags: ['stores'] } },
			});
			const model = buildApiModel(document, buildOperations(document));
			assert.deepStrictEqual(
				model.groups.map((g) => ({ name: g.name, count: g.operations.length })),
				[
					{ name: 'pets', count: 1 },
					{ name: 'stores', count: 1 },
				]
			);
			assert.strictEqual(model.groups[0].operations[0].group, 'pets');
		});

		test('buildApiModel sorts groups alphabetically and propagates tag descriptions (R-DISC-2)', () => {
			const document = docWith({
				'/b': { get: { tags: ['bravo'] } },
				'/a': { get: { tags: ['alpha'] } },
			});
			document.tags = [
				{ name: 'alpha', description: 'Alpha operations' },
				{ name: 'bravo', description: 'Bravo operations' },
			];
			const model = buildApiModel(document, buildOperations(document));
			assert.deepStrictEqual(
				model.groups.map((g) => ({ name: g.name, description: g.description })),
				[
					{ name: 'alpha', description: 'Alpha operations' },
					{ name: 'bravo', description: 'Bravo operations' },
				]
			);
		});

		test('buildOperationIndex flattens the model without drift', () => {
			const document = docWith({
				'/pets': { get: { tags: ['pets'] } },
				'/pets/{petId}': { get: { tags: ['pets'] } },
				'/ping': { get: {} },
			});
			const model = buildApiModel(document, buildOperations(document));
			const index = buildOperationIndex(model);
			assert.strictEqual(index.size, model.groups.reduce((n, g) => n + g.operations.length, 0));
			for (const group of model.groups) {
				for (const op of group.operations) {
					assert.strictEqual(index.get(op.operationId), op);
				}
			}
			assert.strictEqual(index.get('pets-get-pets')?.group, 'pets');
			assert.strictEqual(index.get('default-get-ping')?.group, 'default');
		});

		test('operationsInGroups returns found operations and unknown names', () => {
			const document = docWith({
				'/pets': { get: { tags: ['pets'] }, post: { tags: ['pets'] } },
				'/stores': { post: { tags: ['stores'] } },
			});
			const model = buildApiModel(document, buildOperations(document));

			const both = operationsInGroups(model, ['pets', 'stores']);
			assert.strictEqual(both.found.length, 3);
			assert.deepStrictEqual(both.unknown, []);

			const partial = operationsInGroups(model, ['stores', 'nope']);
			assert.strictEqual(partial.found.length, 1);
			assert.deepStrictEqual(partial.unknown, ['nope']);
		});

		test('merges path-item-level and operation-level parameters with path params required', () => {
			const ops = buildOperations(
				docWith({
					'/pets/{petId}': {
						parameters: [{ name: 'petId', in: 'path', schema: { type: 'string' } }, { name: 'verbose', in: 'query' }],
						get: { tags: ['pets'], parameters: [{ name: 'verbose', in: 'query', required: true }] },
					},
				})
			);
			assert.strictEqual(ops[0].parameters.length, 2);
			const petId = ops[0].parameters.find((p) => p.name === 'petId');
			const verbose = ops[0].parameters.find((p) => p.name === 'verbose');
			assert.strictEqual(petId?.required, true);
			assert.strictEqual(verbose?.required, true);
		});

		test('ignores non-method path-item keys like summary', () => {
			const paths = {
				'/pets': { summary: 'Pets', get: { tags: ['pets'] } },
			} as OpenApiDocument['paths'];
			const ops = buildOperations(docWith(paths));
			assert.strictEqual(ops.length, 1);
			assert.strictEqual(ops[0].method, 'get');
		});

		test('is deterministic across repeated calls (R-ID-4)', () => {
			const paths: OpenApiDocument['paths'] = {
				'/a_b/{id}/c': { get: {}, post: {} },
				'/x': { delete: {}, put: {} },
				'/y': { patch: { tags: ['t2'] }, head: { tags: ['t1'] } },
			};
			const first = JSON.stringify(buildOperations(docWith(paths)));
			for (let i = 0; i < 100; i++) {
				assert.strictEqual(JSON.stringify(buildOperations(docWith(paths))), first);
			}
		});

		test('findOperation resolves by id', () => {
			const document = docWith({
				'/pets': { get: { tags: ['pets'] } },
			});
			const index = buildOperationIndex(buildApiModel(document, buildOperations(document)));
			assert.ok(index.get('pets-get-pets'));
			assert.strictEqual(findOperation(index, 'pets-get-pets'), index.get('pets-get-pets'));
			assert.strictEqual(findOperation(index, 'nope'), undefined);
		});
	});
});
