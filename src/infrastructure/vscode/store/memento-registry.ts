/**
 * The API registry: durable storage of registrations over `vscode.Memento`
 * (globalState) with last-good snapshots (R-REG-5..7).
 */
import type { Memento } from 'vscode';
import { ApiRegistry, RegistryEntry, UpsertResult } from '../../../application';
import { ApiRegistration, buildOperationIndex } from '../../../domain';

/** Memento key under which the `ApiRegistration[]` array is persisted. */
const REGISTRY_KEY = 'registeredApis';

/**
 * Store of registered APIs backed by a VS Code `Memento`.
 */
export class MementoApiRegistry implements ApiRegistry {
	private readonly entries = new Map<string, RegistryEntry>();

	/**
	 * @param memento - Usually `context.globalState`; any `Memento` works.
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
	 * Inserts a new registration or reports a conflict when the `apiId` is already taken.
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
	 * Replaces the snapshot of an existing registration (refresh path).
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
	 * Removes a registration.
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
