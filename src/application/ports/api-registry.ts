import { ApiIndexEntry, ApiModel, ApiRegistration, OperationInfo } from '../../domain';

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
 *
 * The index (`list`/`has`) is kept in `vscode.Memento` and is synchronous.
 * Full registrations are stored per-API in `globalStorage` and are loaded
 * on demand — `get`/`getEntry` are `Promise`-based and cache the derived
 * {@link RegistryEntry} (model + index) after the first load for an `apiId`.
 */
export interface ApiRegistry {
	/** @returns Lightweight index of all registrations in insertion order (from Memento, no file I/O). */
	list(): readonly ApiIndexEntry[];
	/** @param apiId - Registration ID to check. */
	has(apiId: string): boolean;

	/** @param apiId - Registration ID to look up (lazy file load). */
	get(apiId: string): Promise<ApiRegistration | undefined>;
	/** @param apiId - Registration whose runtime view is requested (lazy file load). */
	getEntry(apiId: string): Promise<RegistryEntry | undefined>;

	upsert(registration: ApiRegistration): Promise<UpsertResult>;
	replaceSnapshot(apiId: string, snapshot: ApiRegistration['snapshot']): Promise<boolean>;
	remove(apiId: string): Promise<boolean>;
}
