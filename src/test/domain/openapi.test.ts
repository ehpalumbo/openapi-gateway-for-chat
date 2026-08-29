/**
 * Unit tests for OpenAPI document parsing and validation (`core/openapi.ts`).
 *
 * Pure Node tests: no `vscode` import, runnable via `npm run test:unit`.
 * Each rejection case asserts on the actionable error message content so
 * regressions in guidance quality (NFR-3) are caught, not just error types.
 */
import * as assert from 'assert';
import { isSupportedVersion, parseSpec, SpecError } from '../../domain';

suite('core/openapi', () => {
	suite('isSupportedVersion', () => {
		test('accepts 3.0.x and 3.1.x versions', () => {
			assert.strictEqual(isSupportedVersion('3.0.0'), true);
			assert.strictEqual(isSupportedVersion('3.0.3'), true);
			assert.strictEqual(isSupportedVersion('3.1.0'), true);
		});

		test('rejects other versions', () => {
			assert.strictEqual(isSupportedVersion('2.0'), false);
			assert.strictEqual(isSupportedVersion('4.0.0'), false);
			assert.strictEqual(isSupportedVersion('3'), false);
			assert.strictEqual(isSupportedVersion(''), false);
		});
	});

	suite('parseSpec', () => {
		/** A minimal valid document used as the base for positive cases. */
		const validDoc = {
			openapi: '3.0.3',
			info: { title: 'Petstore', version: '1.0.0' },
			paths: {},
		};

		/**
		 * Convenience wrapper parsing an object literal as JSON text.
		 *
		 * @param doc - Document object to serialize and parse.
		 */
		function parseObject(doc: object): void {
			parseSpec(JSON.stringify(doc));
		}

		test('parses a valid 3.0.x document', () => {
			const doc = parseSpec(JSON.stringify(validDoc));
			assert.strictEqual(doc.openapi, '3.0.3');
			assert.strictEqual(doc.info.title, 'Petstore');
		});

		test('parses a valid 3.1.x document', () => {
			parseObject({ ...validDoc, openapi: '3.1.0' });
		});

		test('rejects Swagger 2.0 with an actionable message', () => {
			assert.throws(
				() => parseSpec(JSON.stringify({ swagger: '2.0', info: { title: 'X', version: '1' }, paths: {} })),
				(err: unknown) => err instanceof SpecError && /Swagger 2\.0 documents are not supported/.test(err.message)
			);
		});

		test('rejects unsupported future version naming supported versions', () => {
			assert.throws(
				() => parseSpec(JSON.stringify({ ...validDoc, openapi: '4.0.0' })),
				(err: unknown) => err instanceof SpecError && /Unsupported OpenAPI version "4\.0\.0".*3\.0\.x.*3\.1\.x/.test(err.message)
			);
		});

		test('rejects YAML-looking input pointing at JSON-only support', () => {
			const yaml = 'openapi: 3.0.3\ninfo:\n  title: Petstore\n';
			assert.throws(
				() => parseSpec(yaml),
				(err: unknown) => err instanceof SpecError && /looks like YAML.*JSON/.test(err.message)
			);
		});

		test('rejects malformed JSON with parse detail', () => {
			assert.throws(
				() => parseSpec('{"openapi": "3.0.3",'),
				(err: unknown) => err instanceof SpecError && /Failed to parse the document as JSON/.test(err.message)
			);
		});

		test('rejects empty documents', () => {
			assert.throws(() => parseSpec('   '), (err: unknown) => err instanceof SpecError && /empty/i.test(err.message));
		});

		test('rejects non-object top-level JSON', () => {
			assert.throws(
				() => parseSpec('[1, 2, 3]'),
				(err: unknown) => err instanceof SpecError && /not an OpenAPI object/.test(err.message)
			);
		});

		test('rejects missing openapi field', () => {
			assert.throws(
				() => parseSpec(JSON.stringify({ info: { title: 'X', version: '1' } })),
				(err: unknown) => err instanceof SpecError && /no "openapi" version field/.test(err.message)
			);
		});

		test('rejects missing info.title', () => {
			assert.throws(
				() => parseSpec(JSON.stringify({ openapi: '3.0.3', info: { version: '1' } })),
				(err: unknown) => err instanceof SpecError && /info\.title/.test(err.message)
			);
		});
	});
});
