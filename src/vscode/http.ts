/**
 * Size-limited HTTP fetching of remote documents (NFR-2).
 *
 * Uses the global `fetch` (Node >= 18 in the VS Code runtime) and enforces a
 * byte cap before any request (via `Content-Length`) and while streaming the
 * response body, so an oversized document can never be fully buffered.
 */
export class HttpFetchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HttpFetchError';
	}
}

/**
 * Error thrown when the target URL is invalid or uses a protocol other than
 * http/https. Thrown before any network call is made.
 */
export class ProtocolNotAllowedError extends HttpFetchError {
	constructor(message: string) {
		super(message);
		this.name = 'ProtocolNotAllowedError';
	}
}

/**
 * Error thrown when the response exceeds the configured byte cap, either by
 * declared `Content-Length` or by accumulated streamed bytes.
 */
export class SizeLimitExceededError extends HttpFetchError {
	constructor(message: string) {
		super(message);
		this.name = 'SizeLimitExceededError';
	}
}

/**
 * Fetches a text document over HTTP(S) with a hard byte cap.
 *
 * Redirects are followed; the final URL after redirects is returned so callers
 * can persist the effective source. Non-2xx responses abort with an actionable
 * error.
 *
 * @param url - Absolute URL to fetch. Only `http:` and `https:` are allowed.
 * @param maxBytes - Maximum number of body bytes to accept.
 * @returns The decoded UTF-8 body text and the final URL after redirects.
 * @throws {ProtocolNotAllowedError} For malformed URLs or non-http(s) protocols,
 *         before any network call.
 * @throws {SizeLimitExceededError} When the declared or received size exceeds `maxBytes`.
 * @throws {HttpFetchError} For network failures or non-2xx responses.
 */
export async function fetchWithLimit(url: string, maxBytes: number): Promise<{ text: string; finalUrl: string }> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new ProtocolNotAllowedError(
			`"${url}" is not a valid absolute URL. Provide an absolute http:// or https:// URL to an OpenAPI JSON document.`
		);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new ProtocolNotAllowedError(
			`Only http:// and https:// URLs can be fetched (got "${parsed.protocol}"). Refusing to fetch "${url}".`
		);
	}

	let response: Response;
	try {
		response = await fetch(parsed, { redirect: 'follow' });
	} catch (err) {
		throw new HttpFetchError(
			`Failed to reach "${url}": ${err instanceof Error ? err.message : String(err)}. Check that the server is reachable and the URL is correct.`
		);
	}

	if (!response.ok) {
		throw new HttpFetchError(
			`The request to "${url}" failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}. Verify the URL points to a served OpenAPI JSON document.`
		);
	}

	const declaredLength = Number(response.headers.get('content-length') ?? Number.NaN);
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		void response.body?.cancel();
		throw new SizeLimitExceededError(sizeMessage(url, maxBytes));
	}

	const reader = response.body?.getReader();
	let text: string;
	if (!reader) {
		text = await response.text();
		if (Buffer.byteLength(text, 'utf8') > maxBytes) {
			throw new SizeLimitExceededError(sizeMessage(url, maxBytes));
		}
	} else {
		const chunks: Uint8Array[] = [];
		let received = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			received += value.byteLength;
			if (received > maxBytes) {
				void reader.cancel();
				throw new SizeLimitExceededError(sizeMessage(url, maxBytes));
			}
			chunks.push(value);
		}
		text = Buffer.concat(chunks).toString('utf8');
	}

	return { text, finalUrl: response.url || url };
}

function sizeMessage(url: string, maxBytes: number): string {
	return `The resource at "${url}" exceeds the size limit of ${maxBytes} bytes. Serve a smaller OpenAPI JSON document.`;
}
