/**
 * Bearer-token storage over `vscode.SecretStorage` (R-AUTH-2).
 *
 * Tokens are written only here — never into the memento, settings, logs, or
 * tool results (NFR-1).
 */
import type { SecretStorage } from 'vscode';

function secretKey(apiId: string): string {
	return `apiId:${apiId}`;
}

/**
 * Thin wrapper storing one optional Bearer token per registered API.
 */
export class TokenStore {
	constructor(private readonly secrets: SecretStorage) {}

	/**
	 * Stores (or replaces) the token for one API.
	 *
	 * @param apiId - Registered API the token authenticates.
	 * @param token - Secret value; never logged or echoed.
	 */
	setToken(apiId: string, token: string): Thenable<void> {
		return this.secrets.store(secretKey(apiId), token);
	}

	/**
	 * Deletes the token for one API. Missing tokens are ignored.
	 *
	 * @param apiId - Registered API whose token is removed.
	 */
	deleteToken(apiId: string): Thenable<void> {
		return this.secrets.delete(secretKey(apiId));
	}

	/**
	 * Reads the token for one API.
	 *
	 * @param apiId - Registered API to look up.
	 * @returns The stored token, or `undefined` when none was set.
	 */
	getToken(apiId: string): Thenable<string | undefined> {
		return this.secrets.get(secretKey(apiId));
	}
}
