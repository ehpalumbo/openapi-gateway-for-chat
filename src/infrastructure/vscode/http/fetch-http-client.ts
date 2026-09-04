import { HttpClient, HttpRequest, RawHttpResponse } from '../../../application';
import { BodySupplier } from '../../../domain';

/**
 * Fetch-based implementation of the {@link HttpClient} port.
 */
export class FetchHttpClient implements HttpClient {
	async send(request: HttpRequest): Promise<RawHttpResponse> {
		const signal = request.timeoutMs ? AbortSignal.timeout(request.timeoutMs) : undefined;
		let fetchBody: string | Uint8Array | undefined;
		if (typeof request.body === 'function') {
			fetchBody = await (request.body as BodySupplier)();
		} else if (typeof request.body === 'string') {
			fetchBody = request.body;
		} else if (request.body instanceof Uint8Array) {
			fetchBody = request.body;
		}
		const response = await fetch(request.url, {
			method: request.method,
			headers: request.headers,
			body: fetchBody,
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
