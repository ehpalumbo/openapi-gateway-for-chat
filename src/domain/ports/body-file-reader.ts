/**
 * Port for reading local file bodies supplied via `bodyFile`.
 *
 * Resolution of absolute vs workspace-relative vs `file://` URIs is private
 * to the infrastructure implementation; domain only interacts via `stat`/`read`.
 */
export interface BodyFileReader {
	/**
	 * Check accessibility and size of the file referenced by `llmPath`.
	 * `llmPath` may be bare absolute, workspace-relative, or `file://` URI.
	 * Throws {@link RequestBuildError} on not found / not file.
	 */
	stat(llmPath: string): Promise<FileDescriptor>;
	/**
	 * Read raw bytes of the file referenced by `llmPath`.
	 */
	read(llmPath: string): Promise<Uint8Array>;
}

/**
 * A file descriptor returned by {@link BodyFileReader.stat}.
 */
export interface FileDescriptor {
	size: number;
	resolvedUri?: string;
}
