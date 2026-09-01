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
		for (const entry of this.registry.list()) {
			try {
				const text = await this.specLoader.load(entry.source);
				await this.registry.replaceSnapshot(entry.apiId, buildSnapshot(text));
			} catch (err) {
				failures.push(`${entry.apiId}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		return failures;
	}
}
