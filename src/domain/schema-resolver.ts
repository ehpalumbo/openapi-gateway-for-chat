/**
 * `$ref` closure resolution (R-SCH-1/2).
 *
 * Pure logic over a {@link SchemaRegistry}: given starting component names
 * (as they appear in `$ref` strings), this module collects the transitive
 * closure of referenced schemas so a tool response can list them "after each
 * other" and stay fully self-contained. Unrelated components are never
 * included; cycles terminate via a visited set.
 */
import { JsonSchema, SchemaRegistry } from './types';

/**
 * One resolved schema component: its name within the registry plus the schema
 * body itself, ready to be embedded verbatim in tool output.
 */
export interface ResolvedSchema {
	/** Component name as keyed in the {@link SchemaRegistry}. */
	name: string;
	/** The referenced schema body. */
	schema: JsonSchema;
}

/**
 * Raised when a reference cannot be resolved against the schema registry (or
 * is not a supported local reference).
 */
export class SchemaResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SchemaResolutionError';
	}
}

/** Prefix identifying the only reference kind the MVP resolves. */
const SCHEMA_REF_PREFIX = '#/components/schemas/';

function refToName(ref: string): string | undefined {
	if (!ref.startsWith(SCHEMA_REF_PREFIX)) {
		return undefined;
	}
	const name = ref.slice(SCHEMA_REF_PREFIX.length);
	return name.length > 0 ? name : undefined;
}

/**
 * Collects all local `#/components/schemas/...` references appearing anywhere
 * inside a value (objects, arrays, nested), in encounter order. Non-local refs
 * (external files, other component kinds) are ignored — they are out of scope
 * for the MVP resolver.
 *
 * @param value - Any JSON value, typically a parameter or content schema.
 * @param into - Array to append discovered references to.
 * @returns The same array for chaining convenience.
 */
export function collectSchemaRefs(value: unknown, into: string[] = []): string[] {
	if (Array.isArray(value)) {
		for (const item of value) {
			collectSchemaRefs(item, into);
		}
		return into;
	}
	if (value === null || typeof value !== 'object') {
		return into;
	}
	const record = value as Record<string, unknown>;
	const ref = record['$ref'];
	if (typeof ref === 'string' && ref.startsWith(SCHEMA_REF_PREFIX) && !into.includes(ref)) {
		into.push(ref);
	}
	for (const child of Object.values(record)) {
		collectSchemaRefs(child, into);
	}
	return into;
}

/**
 * Resolves one starting `$ref` to its transitive closure of registry entries,
 * flattened in encounter order so callers can list schemas after each other
 * per R-SCH-1.
 *
 * Cycle-safe: self-references and mutual recursion terminate via a visited set,
 * with each distinct component emitted exactly once.
 *
 * @param schemas - Schema registry of the API's model.
 * @param rootRef - Starting reference such as `#/components/schemas/NewPet`.
 * @returns Referenced schemas in encounter order.
 * @throws {SchemaResolutionError} When `rootRef` is not a local schema
 *          reference, or a referenced component does not exist.
 */
export function resolveSchemaClosure(schemas: SchemaRegistry, rootRef: string): ResolvedSchema[] {
	return resolveSchemaClosures(schemas, [rootRef]);
}

/**
 * Multi-root variant of {@link resolveSchemaClosure}: resolves several starting
 * references into one deduplicated closure, preserving first-encounter order.
 *
 * @param schemas - Schema registry of the API's model.
 * @param rootRefs - Starting references, e.g. every `$ref` of an operation.
 * @returns Referenced schemas in encounter order, each exactly once.
 * @throws {SchemaResolutionError} When any referenced component does not exist.
 */
export function resolveSchemaClosures(schemas: SchemaRegistry, rootRefs: string[]): ResolvedSchema[] {
	const resolved: ResolvedSchema[] = [];
	const visited = new Set<string>();

	const visit = (ref: string): void => {
		const name = refToName(ref);
		if (name === undefined || visited.has(name)) {
			return;
		}
		visited.add(name);
		const schema = schemas[name];
		if (!schema) {
			throw new SchemaResolutionError(
				`Unresolvable $ref "${ref}": the schema registry has no entry named "${name}".`
			);
		}
		resolved.push({ name, schema });
		for (const childRef of collectSchemaRefs(schema)) {
			visit(childRef);
		}
	};

	for (const rootRef of rootRefs) {
		if (!refToName(rootRef)) {
			throw new SchemaResolutionError(
				`Unsupported $ref "${rootRef}": only local "#/components/schemas/..." references are resolved.`
			);
		}
		visit(rootRef);
	}
	return resolved;
}
