import { ApiIndexEntry, ApiModel, ApiRegistration, OperationInfo } from '../../domain';

/**
 * Result of {@link ApiRegistry.insert}.
 * - `created`: the registration was stored.
 * - `conflict`: an API with the same `apiId` already exists; nothing changed
 *   and the caller resolves the conflict by prompting (R-REG-8).
 */
export type InsertResult = { status: 'created' } | { status: 'conflict'; existingTitle: string };

/** @deprecated Use {@link InsertResult} — `upsert` was a misnomer (insert-only, no update). */
export type UpsertResult = InsertResult;

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
 * The registry maintains a synchronous lightweight index (`list`/`has`) and
 * lazy-loads full registrations on demand — `get`/`getEntry` are
 * `Promise`-based and cache the derived {@link RegistryEntry} (model + index)
 * after the first load for an `apiId`.
 */
export interface ApiRegistry {
	/** @returns Lightweight index of all registrations in insertion order. */
	list(): readonly ApiIndexEntry[];
	/** @param apiId - Registration ID to check. */
	has(apiId: string): boolean;

	/** @param apiId - Registration ID to look up. */
	get(apiId: string): Promise<ApiRegistration | undefined>;
	/** @param apiId - Registration whose runtime view is requested. */
	getEntry(apiId: string): Promise<RegistryEntry | undefined>;

	insert(registration: ApiRegistration): Promise<InsertResult>;

	/** @deprecated Use {@link insert} — misnamed, does not update existing entries. */
	upsert(registration: ApiRegistration): Promise<InsertResult>;
	replaceSnapshot(apiId: string, snapshot: ApiRegistration['snapshot']): Promise<boolean>;
	remove(apiId: string): Promise<boolean>;
}
