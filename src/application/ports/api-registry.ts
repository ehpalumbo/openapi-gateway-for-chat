import { ApiModel, ApiRegistration, OperationInfo } from '../../domain';

/**
 * Result of {@link ApiRegistry.upsert}.
 * - `created`: the registration was stored.
 * - `conflict`: an API with the same `apiId` already exists; nothing changed
 *   and the caller resolves the conflict by prompting (R-REG-8).
 */
export type UpsertResult = { status: 'created' } | { status: 'conflict'; existingTitle: string };

/**
 * Runtime view of one registered API with its operation index.
 */
export interface RegistryEntry {
	/** Persisted registration including its last-good snapshot. */
	registration: ApiRegistration;
	/** Convenience alias of `registration.snapshot.model`. */
	model: ApiModel;
	/** Operation-ID → operation map derived from `model`, unique within this API. */
	index: Map<string, OperationInfo>;
}

/**
 * Durable storage of API registrations and last-good snapshots (R-REG-5..7).
 */
export interface ApiRegistry {
	load(): void;
	upsert(registration: ApiRegistration): UpsertResult;
	replaceSnapshot(apiId: string, snapshot: ApiRegistration['snapshot']): boolean;
	remove(apiId: string): boolean;
	list(): ApiRegistration[];
	get(apiId: string): ApiRegistration | undefined;
	has(apiId: string): boolean;
	getEntry(apiId: string): RegistryEntry | undefined;
}
