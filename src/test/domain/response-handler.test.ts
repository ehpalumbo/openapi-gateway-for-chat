/**
 * Pure Node tests for the response-handler helpers (R-RESP-*): no `vscode`
 * import, runnable via `npm run test:unit`.
 */
import * as assert from 'assert';
import {
	buildSpillFileName,
	extensionForMimeType,
	isSupportedImageContentType,
	isTextContentType,
} from '../../domain';

suite('Response handler helpers', () => {
	test('isTextContentType covers text families and ignores parameters and case', () => {
		for (const contentType of ['text/plain', 'application/json', 'application/vnd.api+json; charset=utf-8', 'Text/Plain', 'APPLICATION/JSON']) {
			assert.ok(isTextContentType(contentType), `${contentType} is textual`);
		}
		for (const contentType of ['image/png', 'application/octet-stream', 'application/pdf', '']) {
			assert.ok(!isTextContentType(contentType), `${contentType} is not textual`);
		}
	});

	test('isSupportedImageContentType accepts only vision-safe image MIME types', () => {
		for (const contentType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'Image/PNG; q=1']) {
			assert.ok(isSupportedImageContentType(contentType), `${contentType} is a supported image`);
		}
		for (const contentType of ['image/svg+xml', 'image/tiff', 'text/plain', 'application/octet-stream']) {
			assert.ok(!isSupportedImageContentType(contentType), `${contentType} is not a supported image`);
		}
	});

	test('extension derivation covers common families and falls back to .bin', () => {
		assert.strictEqual(extensionForMimeType('application/json'), 'json');
		assert.strictEqual(extensionForMimeType('application/hal+json'), 'json');
		assert.strictEqual(extensionForMimeType('text/plain'), 'txt');
		assert.strictEqual(extensionForMimeType('text/csv'), 'csv');
		assert.strictEqual(extensionForMimeType('image/png'), 'png');
		assert.strictEqual(extensionForMimeType('application/pdf'), 'pdf');
		assert.strictEqual(extensionForMimeType('weird'), 'bin');
	});

	test('file names are sanitized, unique per random token, and keep their extension', () => {
		let counter = 0;
		const token = (): string => `${++counter}`;
		assert.strictEqual(buildSpillFileName('pets/get pet', 'application/pdf', token), 'pets-get-pet-1.pdf');
		assert.notStrictEqual(buildSpillFileName(undefined, 'application/pdf', token), buildSpillFileName(undefined, 'application/pdf', token));
	});
});
