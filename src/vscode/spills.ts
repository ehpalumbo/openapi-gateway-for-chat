/**
 * Spill store for response bodies that cannot be delivered as model-readable
 * parts. Copilot Chat only forwards text parts and image data parts from tool
 * results into the prompt (non-image `LanguageModelDataPart`s render as empty
 * strings, see microsoft/vscode#275300), so non-image binary bodies are
 * written to disk instead and referenced by absolute path.
 *
 * All file operations go through `vscode.workspace.fs`; files live under
 * `<storageUri>/response-spills/` with UUID-suffixed names so concurrent or
 * repeated calls never override each other, and every written path is
 * recorded for best-effort deletion on extension deactivation.
 */
import * as crypto from 'crypto';
import * as vscode from 'vscode';

/** Writes one spilled payload; resolves with its absolute path. */
export type SpillWriter = (fileName: string, bytes: Uint8Array) => Promise<string>;

/** Writer plus the cleanup guarantee for spilled response bodies. */
export interface SpillStore {
	/** Satisfies the {@link SpillWriter} seam used by the invoke tool. */
	write(fileName: string, bytes: Uint8Array): Promise<string>;
	/** Best-effort deletion of every file this store created. */
	cleanup(): Promise<void>;
}

const SPILL_DIR_NAME = 'response-spills';

export class WorkspaceSpillStore implements SpillStore {
	private readonly spillDir: vscode.Uri;
	private readonly written = new Set<string>();

	constructor(storageUri: vscode.Uri) {
		this.spillDir = vscode.Uri.joinPath(storageUri, SPILL_DIR_NAME);
	}

	async write(fileName: string, bytes: Uint8Array): Promise<string> {
		await vscode.workspace.fs.createDirectory(this.spillDir);
		const fileUri = vscode.Uri.joinPath(this.spillDir, fileName);
		await vscode.workspace.fs.writeFile(fileUri, bytes);
		this.written.add(fileUri.fsPath);
		return fileUri.fsPath;
	}

	async cleanup(): Promise<void> {
		for (const fsPath of this.written) {
			try {
				await vscode.workspace.fs.delete(vscode.Uri.file(fsPath));
			} catch {
				// best effort: a missing or locked file must not block the rest
			}
		}
		this.written.clear();
		try {
			await vscode.workspace.fs.delete(this.spillDir, { recursive: true });
		} catch {
			// directory removal is opportunistic; files are already gone
		}
	}
}

/** UUID token used to make spill names unique across concurrent calls. */
export function randomToken(): string {
	return crypto.randomUUID();
}
