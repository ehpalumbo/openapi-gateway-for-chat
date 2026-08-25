/**
 * Pure helpers for classifying response bodies and naming spill files
 * (R-RESP-*): no `vscode` import (NFR-6).
 *
 * The invoke tool routes bodies as follows:
 * - textual (`text/*`, JSON, `+json`) → text part with the UTF-8 body;
 * - supported image MIME → `LanguageModelDataPart` (Copilot forwards those);
 * - everything else → spilled to disk and referenced by absolute path.
 */

/** Base content types inlined whole as text parts. */
const TEXT_TYPES = ['application/json'];

/**
 * Decides whether a base content type is textual. Non-text, non-image types
 * are binary per R-RESP-3.
 */
export function isTextContentType(contentType: string): boolean {
	const base = contentType.split(';')[0].trim().toLowerCase();
	return base.startsWith('text/') || TEXT_TYPES.includes(base) || base.endsWith('/json') || base.endsWith('+json');
}

/** Image MIME types Copilot reliably forwards as vision input. */
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);

/** Decides whether a base content type can be served as an image data part. */
export function isSupportedImageContentType(contentType: string): boolean {
	return SUPPORTED_IMAGE_TYPES.has(contentType.split(';')[0].trim().toLowerCase());
}

/**
 * Derives a safe file extension from a MIME type so agents can run tools
 * like `jq` directly against spilled files.
 */
export function extensionForMimeType(mimeType: string): string {
	const base = mimeType.split(';')[0].trim().toLowerCase();
	if (!base) {
		return 'bin';
	}
	if (base === 'application/json' || base.endsWith('+json')) {
		return 'json';
	}
	if (base === 'text/plain') {
		return 'txt';
	}
	if (base === 'text/html') {
		return 'html';
	}
	if (base.startsWith('text/')) {
		return base.slice('text/'.length);
	}
	if (base.startsWith('image/')) {
		return base.slice('image/'.length).replace(/[^a-z0-9]/g, '') || 'bin';
	}
	const subtype = base.split('/')[1];
	return subtype && /^[a-z0-9._-]+$/.test(subtype) ? subtype : 'bin';
}

/**
 * Builds a unique spill file name: `<hint>-<random>.<ext>`. The random token
 * guarantees that repeated or concurrent calls never override each other.
 */
export function buildSpillFileName(hint: string | undefined, mimeType: string, randomToken: () => string): string {
	const safeHint = (hint ?? 'response').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'response';
	return `${safeHint}-${randomToken()}.${extensionForMimeType(mimeType)}`;
}
