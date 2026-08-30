import { ApiRegistry, TokenStore } from '../ports';

export class UnregisterApiUseCase {
	constructor(
		private readonly registry: ApiRegistry,
		private readonly tokenStore: TokenStore
	) {}

	/**
	 * Unregisters an API and removes any associated token (R-REG-3).
	 *
	 * @param apiId - Unique identifier of the API to remove.
	 * @returns Whether the API was found and removed.
	 */
	async execute(apiId: string): Promise<boolean> {
		const removed = await this.registry.remove(apiId);
		if (removed) {
			await this.tokenStore.deleteToken(apiId);
		}
		return removed;
	}
}
