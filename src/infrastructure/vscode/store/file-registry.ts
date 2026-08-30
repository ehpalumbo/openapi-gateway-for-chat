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

type Fs = Pick<typeof vscode.workspace.fs, 'readFile' | 'writeFile' | 'delete' | 'createDirectory'>;

function createInMemoryFs(store: Map<string, Uint8Array>): Fs {
	return {
		async readFile(uri: vscode.Uri): Promise<Uint8Array> {
			const key = uri.fsPath ?? uri.path;
			const data = store.get(key);
			if (!data) {
				throw new Error(`File not found: ${key}`);
			}
			return data;
		},
		async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
			store.set(uri.fsPath ?? uri.path, content);
		},
		async delete(uri: vscode.Uri): Promise<void> {
			store.delete(uri.fsPath ?? uri.path);
		},
		async createDirectory(): Promise<void> {
			// no-op for in-memory
		},
	};
}

const fallbackFsPerMemento = new WeakMap<vscode.Memento, Map<string, Uint8Array>>();

export class FileBackedApiRegistry implements ApiRegistry {
	private readonly index = new Map<string, ApiIndexEntry>();
	private readonly cache = new Map<string, RegistryEntry>();
	private readonly registrationsDir: vscode.Uri;
	private readonly fs: Fs;

	constructor(
		private readonly memento: vscode.Memento,
		globalStorageUri?: vscode.Uri,
		fs?: Fs,
	) {
		if (globalStorageUri && fs) {
			this.fs = fs;
			this.registrationsDir = vscode.Uri.joinPath(globalStorageUri, REGISTRATIONS_DIR);
		} else if (globalStorageUri) {
			this.fs = vscode.workspace.fs;
			this.registrationsDir = vscode.Uri.joinPath(globalStorageUri, REGISTRATIONS_DIR);
		} else {
			let store = fallbackFsPerMemento.get(memento);
			if (!store) {
				store = new Map<string, Uint8Array>();
				fallbackFsPerMemento.set(memento, store);
			}
			this.fs = createInMemoryFs(store);
			// fallback directory is virtual; use a fixed uri per memento
			this.registrationsDir = vscode.Uri.file('/tmp/openapi-gateway-fallback-registrations');
		}
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
			await this.fs.delete(this.fileUriFor(apiId), { useTrash: false });
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
			await this.fs.createDirectory(this.registrationsDir);
		} catch {
			// directory may already exist
		}
		const fileUri = this.fileUriFor(registration.apiId);
		const data = Buffer.from(JSON.stringify(registration), 'utf8');
		await this.fs.writeFile(fileUri, data);
	}

	private async readRegistrationFile(apiId: string): Promise<ApiRegistration | undefined> {
		try {
			const fileUri = this.fileUriFor(apiId);
			const bytes = await this.fs.readFile(fileUri);
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
