import { HttpClient, HttpRequest, RawHttpResponse } from '../../../application';

/**
 * Fetch-based implementation of the {@link HttpClient} port.
 * The request body is already resolved by the use-case (string or bytes).
 */
export class FetchHttpClient implements HttpClient {
	async send(request: HttpRequest): Promise<RawHttpResponse> {
		const signal = request.timeoutMs ? AbortSignal.timeout(request.timeoutMs) : undefined;
		const response = await fetch(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body,
			signal,
		});

		const headers: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			headers[key] = value;
		});

		const arrayBuf = await response.arrayBuffer();
		const body = new Uint8Array(arrayBuf);

		return {
			status: response.status,
			statusText: response.statusText ?? '',
			headers,
			body,
		};
	}
}
