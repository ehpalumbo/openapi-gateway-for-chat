/**
 * Bearer-token storage over `vscode.SecretStorage` (R-AUTH-2).
 */
import type { SecretStorage } from 'vscode';
import { TokenStore } from '../../../application';

function secretKey(apiId: string): string {
	return `apiId:${apiId}`;
}

/**
 * SecretStorage-backed implementation of {@link TokenStore}.
 */
export class SecretTokenStore implements TokenStore {
	constructor(private readonly secrets: SecretStorage) { }

	setToken(apiId: string, token: string): Thenable<void> {
		return this.secrets.store(secretKey(apiId), token);
	}

	deleteToken(apiId: string): Thenable<void> {
		return this.secrets.delete(secretKey(apiId));
	}

	getToken(apiId: string): Thenable<string | undefined> {
		return this.secrets.get(secretKey(apiId));
	}
}
