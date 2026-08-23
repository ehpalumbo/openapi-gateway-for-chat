/**
 * Parsing and validation of OpenAPI documents.
 *
 * The MVP accepts OpenAPI 3.0.x and 3.1.x documents in JSON format only
 * (R-REG-4). All failures throw {@link SpecError} with messages written to be
 * actionable for the user and the language model (NFR-3).
 */
import { OpenApiDocument } from './types';

/**
 * Error thrown when a document cannot be accepted as a supported OpenAPI spec.
 */
export class SpecError extends Error {
	/**
	 * @param message - Actionable description of what is wrong with the document.
	 */
	constructor(message: string) {
		super(message);
		this.name = 'SpecError';
	}
}

/**
 * Checks whether an `openapi` version string is one of the supported versions.
 *
 * @param version - Value of the document's `openapi` field.
 * @returns `true` for 3.0.x and 3.1.x, `false` otherwise.
 */
export function isSupportedVersion(version: string): boolean {
	return /^3\.0\.\d+$/.test(version) || /^3\.1\.\d+$/.test(version);
}

/**
 * Heuristically detects YAML-formatted input to give a targeted error message
 * instead of a generic JSON parse failure.
 *
 * @param text - Raw document text that failed JSON parsing.
 * @returns `true` when the first meaningful line looks like YAML mapping syntax.
 */
function looksLikeYaml(text: string): boolean {
	const firstLine = text
		.split('\n')
		.map((line) => line.trim())
		.find((line) => line.length > 0 && !line.startsWith('#'));
	return firstLine !== undefined && firstLine.includes(':') && !firstLine.startsWith('{') && !firstLine.startsWith('"');
}

/**
 * Parses raw text into a validated {@link OpenApiDocument}.
 *
 * Rejection cases (each with an actionable {@link SpecError} message):
 * empty input, YAML-looking input, malformed JSON, non-object top level,
 * Swagger 2.0 documents, missing or unsupported `openapi` version, and a
 * missing `info.title`.
 *
 * @param jsonText - Raw document text from a URL fetch or workspace file read.
 * @returns The parsed and structurally validated document.
 * @throws {SpecError} When the document violates any acceptance rule of R-REG-4.
 */
export function parseSpec(jsonText: string): OpenApiDocument {
	if (jsonText.trim().length === 0) {
		throw new SpecError('The document is empty. Provide a non-empty OpenAPI 3.0.x or 3.1.x JSON document.');
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (err) {
		if (looksLikeYaml(jsonText)) {
			throw new SpecError(
				'The document does not appear to be valid JSON (it looks like YAML). Only JSON OpenAPI documents are supported; convert the YAML document to JSON and try again.'
			);
		}
		throw new SpecError(
			`Failed to parse the document as JSON: ${err instanceof Error ? err.message : String(err)}. Ensure the URL or file points to a valid OpenAPI 3.0.x/3.1.x JSON document.`
		);
	}

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new SpecError('The document is valid JSON but not an OpenAPI object. Expected a JSON object at the top level.');
	}

	const doc = parsed as Record<string, unknown>;

	if ('swagger' in doc) {
		throw new SpecError('Swagger 2.0 documents are not supported. Convert the document to OpenAPI 3.0.x or 3.1.x and try again.');
	}

	const version = doc['openapi'];
	if (typeof version !== 'string' || version.length === 0) {
		throw new SpecError('The document has no "openapi" version field. A string field "openapi" set to a 3.0.x or 3.1.x version is required.');
	}
	if (!isSupportedVersion(version)) {
		throw new SpecError(`Unsupported OpenAPI version "${version}". Supported versions are 3.0.x and 3.1.x.`);
	}

	const info = doc['info'];
	if (typeof info !== 'object' || info === null || typeof (info as Record<string, unknown>)['title'] !== 'string') {
		throw new SpecError('The document is missing an "info.title" string, which is required to register the API.');
	}

	return parsed as unknown as OpenApiDocument;
}
