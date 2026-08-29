import { ApiRegistry, SpecLoader } from '../ports';
import { buildSnapshot } from './register-api';

export class RefreshApisUseCase {
	constructor(
		private readonly registry: ApiRegistry,
		private readonly specLoader: SpecLoader
	) { }

	/**
	 * Refreshes all registered APIs sequentially (R-REG-6, R-REG-7).
	 *
	 * When a spec fails to fetch or parse, that API keeps its last-good snapshot
	 * intact while remaining APIs continue to refresh.
	 *
	 * @returns An array of error messages for registrations that failed to refresh.
	 */
	async execute(): Promise<string[]> {
		const failures: string[] = [];
		for (const registration of this.registry.list()) {
			try {
				const text = await this.specLoader.load(registration.source);
				this.registry.replaceSnapshot(registration.apiId, buildSnapshot(text));
			} catch (err) {
				failures.push(`${registration.apiId}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		return failures;
	}
}
