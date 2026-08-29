/**
 * Port interface for Bearer-token secret storage (R-AUTH-2, NFR-1).
 */
export interface TokenStore {
	/**
	 * Stores (or replaces) the token for one API.
	 *
	 * @param apiId - Registered API the token authenticates.
	 * @param token - Secret value; never logged or echoed.
	 */
	setToken(apiId: string, token: string): Promise<void> | Thenable<void>;

	/**
	 * Deletes the token for one API. Missing tokens are ignored.
	 *
	 * @param apiId - Registered API whose token is removed.
	 */
	deleteToken(apiId: string): Promise<void> | Thenable<void>;

	/**
	 * Reads the token for one API.
	 *
	 * @param apiId - Registered API to look up.
	 * @returns The stored token, or `undefined` when none was set.
	 */
	getToken(apiId: string): Promise<string | undefined> | Thenable<string | undefined>;
}
