/**
 * Deferred file-backed API registry: index in `vscode.Memento` (`globalState`)
 * and per-API registrations in `globalStorage` files.
 *
 * Only the lightweight {@link ApiIndexEntry} array is loaded on activation.
 * Full {@link ApiRegistration} (including `snapshot.model`) is loaded on
 * demand when `apiId` is looked up via `get`/`getEntry`, then cached.
 */
import * as vscode from 'vscode';
import { ApiRegistry, RegistryEntry, UpsertResult } from '../../../application';
import { toIndexEntry } from '../../../application/use-cases/register-api';
import { ApiIndexEntry, ApiRegistration, buildOperationIndex } from '../../../domain';

/** Memento key under which the `ApiIndexEntry[]` array is persisted. */
export const INDEX_KEY = 'registeredApiIndex';

const REGISTRATIONS_DIR = 'registrations';

function sanitizeApiId(apiId: string): string {
	return apiId.replace(/[^a-zA-Z0-9._-]/g, '-');
}

export class FileBackedApiRegistry implements ApiRegistry {
	private readonly index = new Map<string, ApiIndexEntry>();
	private readonly cache = new Map<string, RegistryEntry>();
	private readonly registrationsDir: vscode.Uri;

	constructor(
		private readonly memento: vscode.Memento,
		private readonly globalStorageUri: vscode.Uri,
	) {
		this.registrationsDir = vscode.Uri.joinPath(globalStorageUri, REGISTRATIONS_DIR);
		this.loadIndexFromMemento();
	}

	list(): readonly ApiIndexEntry[] {
		return [...this.index.values()];
	}

	has(apiId: string): boolean {
		return this.index.has(apiId);
	}

	async get(apiId: string): Promise<ApiRegistration | undefined> {
		const entry = await this.getEntry(apiId);
		return entry?.registration;
	}

	async getEntry(apiId: string): Promise<RegistryEntry | undefined> {
		if (!this.index.has(apiId)) {
			return undefined;
		}
		const cached = this.cache.get(apiId);
		if (cached) {
			return cached;
		}
		const registration = await this.readRegistrationFile(apiId);
		if (!registration) {
			return undefined;
		}
		const registryEntry = this.toEntry(registration);
		this.cache.set(apiId, registryEntry);
		return registryEntry;
	}

	async upsert(registration: ApiRegistration): Promise<UpsertResult> {
		const existing = this.index.get(registration.apiId);
		if (existing) {
			return { status: 'conflict', existingTitle: existing.title };
		}
		const indexEntry = toIndexEntry(registration);
		this.index.set(registration.apiId, indexEntry);
		await this.persistIndex();
		await this.writeRegistrationFile(registration);
		this.cache.set(registration.apiId, this.toEntry(registration));
		return { status: 'created' };
	}

	async replaceSnapshot(apiId: string, snapshot: ApiRegistration['snapshot']): Promise<boolean> {
		const indexEntry = this.index.get(apiId);
		if (!indexEntry) {
			return false;
		}
		const existing = await this.get(apiId);
		if (!existing) {
			return false;
		}
		const updated: ApiRegistration = { ...existing, snapshot };
		// title/version/description may have changed after re-parse
		updated.title = snapshot.model.info.title;
		updated.version = snapshot.model.info.version;
		const newIndexEntry = toIndexEntry(updated);
		this.index.set(apiId, newIndexEntry);
		await this.persistIndex();
		await this.writeRegistrationFile(updated);
		this.cache.set(apiId, this.toEntry(updated));
		return true;
	}

	async remove(apiId: string): Promise<boolean> {
		if (!this.index.has(apiId)) {
			return false;
		}
		this.index.delete(apiId);
		this.cache.delete(apiId);
		await this.persistIndex();
		try {
			await vscode.workspace.fs.delete(this.fileUriFor(apiId), { useTrash: false });
		} catch {
			// file may not exist — best effort
		}
		return true;
	}

	private loadIndexFromMemento(): void {
		this.index.clear();
		this.cache.clear();
		const raw = this.memento.get<ApiIndexEntry[]>(INDEX_KEY);
		if (!Array.isArray(raw)) {
			return;
		}
		for (const entry of raw) {
			if (entry && typeof entry.apiId === 'string') {
				this.index.set(entry.apiId, entry);
			}
		}
	}

	private async persistIndex(): Promise<void> {
		await this.memento.update(INDEX_KEY, [...this.index.values()]);
	}

	private fileUriFor(apiId: string): vscode.Uri {
		return vscode.Uri.joinPath(this.registrationsDir, `${sanitizeApiId(apiId)}.json`);
	}

	private async writeRegistrationFile(registration: ApiRegistration): Promise<void> {
		try {
			await vscode.workspace.fs.createDirectory(this.registrationsDir);
		} catch {
			// directory may already exist
		}
		const fileUri = this.fileUriFor(registration.apiId);
		const data = Buffer.from(JSON.stringify(registration), 'utf8');
		await vscode.workspace.fs.writeFile(fileUri, data);
	}

	private async readRegistrationFile(apiId: string): Promise<ApiRegistration | undefined> {
		try {
			const fileUri = this.fileUriFor(apiId);
			const bytes = await vscode.workspace.fs.readFile(fileUri);
			const text = Buffer.from(bytes).toString('utf8');
			const parsed = JSON.parse(text) as ApiRegistration;
			// basic validation: must have apiId and snapshot.model
			if (!parsed || parsed.apiId !== apiId || !parsed.snapshot?.model) {
				return undefined;
			}
			return parsed;
		} catch {
			return undefined;
		}
	}

	private toEntry(registration: ApiRegistration): RegistryEntry {
		return {
			registration,
			model: registration.snapshot.model,
			index: buildOperationIndex(registration.snapshot.model),
		};
	}
}
