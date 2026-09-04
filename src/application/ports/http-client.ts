/**
 * Request payload given to the HTTP client port.
 * The body is always resolved bytes by the use-case: inline strings verbatim,
 * file bodies as raw bytes. The client never resolves lazy suppliers.
 */
export interface HttpRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string | Uint8Array;
	timeoutMs?: number;
}

/**
 * Raw response returned by the HTTP client port.
 */
export interface RawHttpResponse {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: Uint8Array;
}

/**
 * Port interface for executing HTTP requests against remote APIs.
 * Decouples the application layer from Node global fetch or any concrete HTTP client.
 */
export interface HttpClient {
	send(request: HttpRequest): Promise<RawHttpResponse>;
}
