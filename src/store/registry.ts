/**
 * The API registry: durable storage of registrations over `vscode.Memento`
 * (globalState) with last-good snapshots (R-REG-5..7).
 *
 * Persisted shape is a plain `ApiRegistration[]` under a single key. For every
 * registration the registry keeps an in-memory runtime view whose operation
 * index is derived from the persisted snapshot on every mutation, so the index
 * can never drift from the model the tools expose.
 */
import type { Memento } from 'vscode';
import { buildOperationIndex } from '../core/operations';
import { ApiModel, ApiRegistration, OperationInfo } from '../core/types';

/** Memento key under which the `ApiRegistration[]` array is persisted. */
const REGISTRY_KEY = 'registeredApis';

/**
 * Result of {@link ApiRegistry.upsert}.
 * - `created`: the registration was stored.
 * - `conflict`: an API with the same `apiId` already exists; nothing changed
 *   and the caller resolves the conflict by prompting (R-REG-8).
 */
export type UpsertResult = { status: 'created' } | { status: 'conflict'; existingTitle: string };

/**
 * Runtime view of one registered API.
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
 * Store of registered APIs backed by a VS Code `Memento`.
 *
 * All mutations persist immediately and rebuild the in-memory views, so two
 * `ApiRegistry` instances over the same memento always observe identical data.
 */
export class ApiRegistry {
	private readonly entries = new Map<string, RegistryEntry>();

	/**
	 * @param memento - Usually `context.globalState`; any `Memento` works,
	 *                  which keeps persistence semantics testable.
	 */
	constructor(private readonly memento: Memento) {
		this.load();
	}

	/**
	 * Rebuilds the in-memory views from persisted state.
	 */
	load(): void {
		this.entries.clear();
		for (const registration of this.readPersisted()) {
			this.entries.set(registration.apiId, this.toEntry(registration));
		}
	}

	/**
	 * Inserts a new registration or reports a conflict when the `apiId` is
	 * already taken. Existing entries are never silently overwritten.
	 *
	 * @param registration - Fully built registration with its snapshot.
	 * @returns `created` after persisting, or `conflict` without mutating state.
	 */
	upsert(registration: ApiRegistration): UpsertResult {
		const existing = this.entries.get(registration.apiId);
		if (existing) {
			return { status: 'conflict', existingTitle: existing.registration.title };
		}
		this.entries.set(registration.apiId, this.toEntry(registration));
		this.persist();
		return { status: 'created' };
	}

	/**
	 * Replaces the snapshot of an existing registration (refresh path), keeping
	 * all other metadata. No-op for unknown IDs.
	 *
	 * @param apiId - Registration to update.
	 * @param snapshot - New last-good snapshot.
	 * @returns Whether an entry was updated.
	 */
	replaceSnapshot(apiId: string, snapshot: ApiRegistration['snapshot']): boolean {
		const entry = this.entries.get(apiId);
		if (!entry) {
			return false;
		}
		entry.registration = { ...entry.registration, snapshot };
		this.entries.set(apiId, this.toEntry(entry.registration));
		this.persist();
		return true;
	}

	/**
	 * Removes a registration and its token-independent metadata.
	 *
	 * @param apiId - Registration to remove.
	 * @returns Whether an entry was removed.
	 */
	remove(apiId: string): boolean {
		if (!this.entries.delete(apiId)) {
			return false;
		}
		this.persist();
		return true;
	}

	/**
	 * @returns All registrations in insertion order.
	 */
	list(): ApiRegistration[] {
		return [...this.entries.values()].map((entry) => entry.registration);
	}

	/**
	 * @param apiId - Registration ID to look up.
	 * @returns The registration, or `undefined`.
	 */
	get(apiId: string): ApiRegistration | undefined {
		return this.entries.get(apiId)?.registration;
	}

	/**
	 * @param apiId - Registration ID to check.
	 */
	has(apiId: string): boolean {
		return this.entries.has(apiId);
	}

	/**
	 * @param apiId - Registration whose runtime view is requested.
	 * @returns The entry with model and derived index, or `undefined`.
	 */
	getEntry(apiId: string): RegistryEntry | undefined {
		return this.entries.get(apiId);
	}

	private toEntry(registration: ApiRegistration): RegistryEntry {
		return {
			registration,
			model: registration.snapshot.model,
			index: buildOperationIndex(registration.snapshot.model),
		};
	}

	private readPersisted(): ApiRegistration[] {
		const raw = this.memento.get<ApiRegistration[]>(REGISTRY_KEY);
		return Array.isArray(raw) ? raw : [];
	}

	private persist(): void {
		void this.memento.update(REGISTRY_KEY, this.list());
	}
}
