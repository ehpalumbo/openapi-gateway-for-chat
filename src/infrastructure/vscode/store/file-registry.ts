/**
 * Deferred file-backed API registry: index in `vscode.Memento` (`globalState`)
 * and per-API registrations in `globalStorage` files.
 *
 * Only the lightweight {@link ApiIndexEntry} array is loaded on activation.
 * Full {@link ApiRegistration} (including `snapshot.model`) is loaded on
 * demand when `apiId` is looked up via `get`/`getEntry`, then cached.
 */
import * as vscode from 'vscode';
import { ApiRegistry, InsertResult, RegistryEntry } from '../../../application';
import { toIndexEntry } from '../../../application/use-cases/register-api';
import { ApiIndexEntry, ApiRegistration, buildOperationIndex, isValidApiId, API_ID_VALIDATION_MESSAGE } from '../../../domain';

/** Memento key under which the `ApiIndexEntry[]` array is persisted. */
export const INDEX_KEY = 'registeredApiIndex';

const REGISTRATIONS_DIR = 'registrations';

function isFileSystemErrorWithCode(err: unknown, code: string): boolean {
	if (err instanceof vscode.FileSystemError) {
		return (err as vscode.FileSystemError).code === code;
	}
	const maybe = err as { code?: unknown; name?: unknown } | null | undefined;
	return typeof maybe?.code === 'string' && maybe.code === code;
}

function isValidIndexEntry(entry: unknown): entry is ApiIndexEntry {
	if (!entry || typeof entry !== 'object') {
		return false;
	}
	const e = entry as ApiIndexEntry;
	if (typeof e.apiId !== 'string' || !isValidApiId(e.apiId)) {
		return false;
	}
	if (typeof e.title !== 'string' || e.title.length === 0) {
		return false;
	}
	if (typeof e.version !== 'string' || e.version.length === 0) {
		return false;
	}
	if (typeof e.baseUrl !== 'string' || e.baseUrl.length === 0) {
		return false;
	}
	try {
		const url = new URL(e.baseUrl);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return false;
		}
	} catch {
		return false;
	}
	if (!e.source || typeof e.source !== 'object') {
		return false;
	}
	const source = e.source as ApiIndexEntry['source'];
	if (source.kind === 'url') {
		if (typeof source.url !== 'string' || source.url.length === 0) {
			return false;
		}
		try {
			const url = new URL(source.url);
			if (url.protocol !== 'http:' && url.protocol !== 'https:') {
				return false;
			}
		} catch {
			return false;
		}
	} else if (source.kind === 'file') {
		if (typeof source.fsPath !== 'string' || source.fsPath.length === 0) {
			return false;
		}
	} else {
		return false;
	}
	if (e.description !== undefined && typeof e.description !== 'string') {
		return false;
	}
	return true;
}

export class FileBackedApiRegistry implements ApiRegistry {
	private readonly index = new Map<string, ApiIndexEntry>();
	private readonly cache = new Map<string, RegistryEntry>();
	private readonly registrationsDir: vscode.Uri;
	private pendingPersist: Promise<void> = Promise.resolve();

	constructor(
		private readonly memento: vscode.Memento,
		private readonly globalStorageUri: vscode.Uri,
	) {
		if (!globalStorageUri) {
			throw new Error('FileBackedApiRegistry requires globalStorageUri to be defined.');
		}
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

	async insert(registration: ApiRegistration): Promise<InsertResult> {
		if (!isValidApiId(registration.apiId)) {
			throw new Error(`Invalid apiId "${registration.apiId}": ${API_ID_VALIDATION_MESSAGE}`);
		}
		const existing = this.index.get(registration.apiId);
		if (existing) {
			return { status: 'conflict', existingTitle: existing.title };
		}
		// Write file first so a disk failure does not leave a stale index entry.
		await this.writeRegistrationFile(registration);
		const indexEntry = toIndexEntry(registration);
		this.index.set(registration.apiId, indexEntry);
		try {
			await this.persistIndex();
		} catch (err) {
			// Roll back in-memory index and best-effort remove the orphaned file.
			this.index.delete(registration.apiId);
			try {
				await vscode.workspace.fs.delete(this.fileUriFor(registration.apiId), { useTrash: false });
			} catch {
				// best effort cleanup
			}
			throw err;
		}
		this.cache.set(registration.apiId, this.toEntry(registration));
		return { status: 'created' };
	}

	/** @deprecated Use insert */
	async upsert(registration: ApiRegistration): Promise<InsertResult> {
		return this.insert(registration);
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
		const previousIndexEntry = this.index.get(apiId);
		// Write file first to avoid persisting an index that points at unwritten state.
		await this.writeRegistrationFile(updated);
		this.index.set(apiId, newIndexEntry);
		try {
			await this.persistIndex();
		} catch (err) {
			// Roll back index and restore previous file on persist failure.
			if (previousIndexEntry) {
				this.index.set(apiId, previousIndexEntry);
			} else {
				this.index.delete(apiId);
			}
			try {
				await this.writeRegistrationFile(existing);
			} catch {
				// best effort restore
			}
			throw err;
		}
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
		} catch (err) {
			if (isFileSystemErrorWithCode(err, 'FileNotFound') || (err as { code?: string })?.code === 'ENOENT') {
				// file already absent — best effort
			} else {
				console.error(`Failed to delete registration file for "${apiId}":`, err);
			}
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
			if (isValidIndexEntry(entry)) {
				this.index.set(entry.apiId, entry);
			}
		}
	}

	private async persistIndex(): Promise<void> {
		const snapshot = [...this.index.values()];
		const task = this.pendingPersist.then(() => this.memento.update(INDEX_KEY, snapshot));
		// Keep queue alive even if this update rejects, but propagate error to caller.
		this.pendingPersist = task.catch(() => {});
		await task;
	}

	private fileUriFor(apiId: string): vscode.Uri {
		return vscode.Uri.joinPath(this.registrationsDir, `${apiId}.json`);
	}

	private async writeRegistrationFile(registration: ApiRegistration): Promise<void> {
		try {
			await vscode.workspace.fs.createDirectory(this.registrationsDir);
		} catch (err) {
			if (isFileSystemErrorWithCode(err, 'FileExists') || (err as { code?: string })?.code === 'EEXIST') {
				// directory already exists — ignore
			} else {
				throw err;
			}
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
				console.error(`Corrupt registration file for "${apiId}": mismatched apiId or missing snapshot.model`);
				return undefined;
			}
			return parsed;
		} catch (err) {
			if (isFileSystemErrorWithCode(err, 'FileNotFound') || (err as { code?: string })?.code === 'ENOENT') {
				return undefined;
			}
			if (err instanceof SyntaxError) {
				console.error(`Corrupt registration file for "${apiId}": invalid JSON`, err);
				return undefined;
			}
			console.error(`Failed to read registration file for "${apiId}":`, err);
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
