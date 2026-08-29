import { SpecSource } from '../../domain';

/**
 * Port interface for loading raw OpenAPI specification text from a SpecSource (URL or file).
 */
export interface SpecLoader {
	load(source: SpecSource): Promise<string>;
}
