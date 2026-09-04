import * as path from 'path';
import * as vscode from 'vscode';
import { RequestBuildError } from '../../../domain';
import { BodyFileReader, FileDescriptor } from '../../../domain/ports/body-file-reader';

/**
 * Returns true if the given error is a VS Code FileSystemError with the specified code.
 */
function isFileSystemErrorWithCode(err: unknown, code: string): boolean {
	if (err instanceof vscode.FileSystemError) {
		return (err as vscode.FileSystemError).code === code;
	}
	const maybe = err as { code?: unknown; name?: unknown } | null | undefined;
	return typeof maybe?.code === 'string' && maybe.code === code;
}

/**
 * A {@link BodyFileReader} implementation that resolves workspace-relative and absolute paths using VS Code's workspace API.
 * Throws {@link RequestBuildError} if the file is not found or not accessible.
 */
export class WorkspaceBodyFileReader implements BodyFileReader {

	/**
	 * Resolves a path to a VS Code URI, handling absolute paths, workspace-relative paths, and `file://` URIs.
	 * Throws {@link RequestBuildError} if the path is an unsupported scheme (e.g., http/https).
	 */
	private resolveInternal(llmPath: string): vscode.Uri {
		if (llmPath.startsWith('http://') || llmPath.startsWith('https://')) {
			throw new RequestBuildError(`Only local files are supported for bodyFile, got: "${llmPath}"`);
		}
		if (llmPath.startsWith('file://')) {
			return vscode.Uri.parse(llmPath);
		}
		if (path.isAbsolute(llmPath)) {
			return vscode.Uri.file(llmPath);
		}
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (workspaceFolder) {
			return vscode.Uri.joinPath(workspaceFolder.uri, llmPath);
		}
		return vscode.Uri.file(llmPath);
	}

	/**
	 * Check accessibility and size of the file referenced by `llmPath`.
	 * `llmPath` may be bare absolute, workspace-relative, or `file://` URI.
	 * Throws {@link RequestBuildError} on not found / not file.
	 */
	async stat(llmPath: string): Promise<FileDescriptor> {
		const uri = this.resolveInternal(llmPath);
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.type !== vscode.FileType.File) {
				throw new RequestBuildError(`Body file not found or not accessible: "${llmPath}": not a file`);
			}
			return { size: stat.size, resolvedUri: uri.fsPath };
		} catch (err) {
			if (err instanceof RequestBuildError) {
				throw err;
			}
			if (isFileSystemErrorWithCode(err, 'FileNotFound') || (err as { code?: string })?.code === 'ENOENT') {
				throw new RequestBuildError(`Body file not found or not accessible: "${llmPath}": ${err instanceof Error ? err.message : String(err)}`);
			}
			// Map any other fs error similarly
			if (err instanceof vscode.FileSystemError) {
				throw new RequestBuildError(`Body file not found or not accessible: "${llmPath}": ${err.message}`);
			}
			throw new RequestBuildError(`Body file not found or not accessible: "${llmPath}": ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Read raw bytes of the file referenced by `llmPath`.
	 */
	async read(llmPath: string): Promise<Uint8Array> {
		const uri = this.resolveInternal(llmPath);
		if (llmPath.startsWith('http://') || llmPath.startsWith('https://')) {
			throw new RequestBuildError(`Only local files are supported for bodyFile, got: "${llmPath}"`);
		}
		try {
			return await vscode.workspace.fs.readFile(uri);
		} catch (err) {
			if (err instanceof RequestBuildError) {
				throw err;
			}
			if (isFileSystemErrorWithCode(err, 'FileNotFound') || (err as { code?: string })?.code === 'ENOENT') {
				throw new RequestBuildError(`Body file not found or not accessible: "${llmPath}": ${err instanceof Error ? err.message : String(err)}`);
			}
			if (err instanceof vscode.FileSystemError) {
				throw new RequestBuildError(`Body file not found or not accessible: "${llmPath}": ${err.message}`);
			}
			throw new RequestBuildError(`Body file not found or not accessible: "${llmPath}": ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
