/**
 * Writes one spilled payload; resolves with its absolute path.
 */
export type SpillWriter = (fileName: string, bytes: Uint8Array) => Promise<string>;

/**
 * Port interface for spilling binary response bodies and lifecycle cleanup (R-RESP-3).
 */
export interface SpillStore {
	/** Satisfies the {@link SpillWriter} seam used by the invoke use case / tool. */
	write(fileName: string, bytes: Uint8Array): Promise<string>;

	/** Best-effort deletion of every file created by this store during the session. */
	cleanup(): Promise<void>;
}
