import * as vscode from 'vscode';
import { SpecLoader } from '../../../application';
import { SpecSource } from '../../../domain';

export const SPEC_FETCH_LIMIT_BYTES = 10 * 1024 * 1024;

export class HttpFetchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HttpFetchError';
	}
}

export class ProtocolNotAllowedError extends HttpFetchError {
	constructor(message: string) {
		super(message);
		this.name = 'ProtocolNotAllowedError';
	}
}

export class SizeLimitExceededError extends HttpFetchError {
	constructor(message: string) {
		super(message);
		this.name = 'SizeLimitExceededError';
	}
}

/**
 * Fetches a text document over HTTP(S) with a hard byte cap (NFR-2).
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
		for (; ;) {
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

/**
 * SpecLoader implementation supporting URL (via fetchWithLimit) and File (via vscode.workspace.fs).
 */
export class FetchSpecLoader implements SpecLoader {
	constructor(private readonly maxBytes: number = SPEC_FETCH_LIMIT_BYTES) { }

	async load(source: SpecSource): Promise<string> {
		if (source.kind === 'url') {
			const { text } = await fetchWithLimit(source.url, this.maxBytes);
			return text;
		}
		const fileData = await vscode.workspace.fs.readFile(vscode.Uri.file(source.fsPath));
		return Buffer.from(fileData).toString('utf8');
	}
}
