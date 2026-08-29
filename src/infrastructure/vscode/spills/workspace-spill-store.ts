/**
 * Spill store for response bodies that cannot be delivered as model-readable parts (R-RESP-3).
 *
 * Uses `vscode.workspace.fs`; files live under `<storageUri>/response-spills/`.
 */
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { SpillStore } from '../../../application';

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
