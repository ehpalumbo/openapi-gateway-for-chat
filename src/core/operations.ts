/**
 * Operation identity (R-ID-*) and grouping (R-GRP-*).
 *
 * All functions are pure and deterministic: the same document always yields
 * the same operation IDs and groups, across activations and refreshes.
 */
import { HTTP_METHODS, ApiModel, HttpMethod, OpenApiDocument, OpenApiOperation, OpenApiParameter, OperationGroupModel, OperationInfo, OperationParameter } from './types';

/** Group assigned to operations that declare no tags. */
const DEFAULT_GROUP = 'default';

/**
 * Derives the kebab-case operation ID for an operation without an explicit
 * `operationId`, following R-ID-2: `<tag>/<method>-<path>` where path-template
 * variables (`{petId}`) are skipped and separators (`/`, `_`) become `-`.
 *
 * @param tag - The operation's group tag (first tag or `default`).
 * @param method - HTTP method; lowercased in the result.
 * @param pathTemplate - Path template such as `/pets/{petId}`.
 * @returns The derived ID, e.g. `pets-get-pets` for tag `pets`,
 *          method `GET`, path `/pets/{petId}`.
 */
export function deriveOperationId(tag: string, method: string, pathTemplate: string): string {
	const kebabPath = pathTemplate
		.split('/')
		.filter((segment) => segment.length > 0 && !segment.startsWith('{'))
		.map((segment) => segment.replace(/[_/]+/g, '-').replace(/^-+|-+$/g, ''))
		.filter((segment) => segment.length > 0)
		.join('-');
	return `${tag}-${method.toLowerCase()}-${kebabPath}`;
}

/**
 * Merges path-item-level and operation-level parameters into one list.
 *
 * A later definition with the same `in` + `name` wins. Path parameters are
 * always marked required per R-INV-3; all others mirror their spec declaration.
 *
 * @param pathItemParams - Parameters declared on the parent path item, if any.
 * @param opParams - Parameters declared on the operation itself, if any.
 * @returns Deduplicated parameters with a resolved {@link OperationParameter.required} flag.
 */
function mergeParameters(pathItemParams: OpenApiParameter[] | undefined, opParams: OpenApiParameter[] | undefined): OperationParameter[] {
	const merged = new Map<string, OpenApiParameter>();
	for (const param of [...(pathItemParams ?? []), ...(opParams ?? [])]) {
		if (typeof param['name'] !== 'string' || typeof param['in'] !== 'string') {
			continue;
		}
		merged.set(`${param['in']}:${param['name']}`, param);
	}
	return [...merged.values()].map((param) => ({ ...param, required: param['in'] === 'path' ? true : param.required === true }));
}

/**
 * Projects a raw spec operation onto the gateway's {@link OperationInfo} shape,
 * minus identity fields that require uniqueness resolution.
 *
 * @param pathItem - Parent path item providing shared parameters.
 * @param pathTemplate - Path template the operation lives under.
 * @param method - HTTP method of the operation.
 * @param op - Raw operation object from the spec.
 * @returns The group/method/parameter/body/response view of the operation.
 */
function toOperationInfo(
	pathItem: { parameters?: OpenApiParameter[] },
	pathTemplate: string,
	method: HttpMethod,
	op: OpenApiOperation
): Omit<OperationInfo, 'operationId' | 'declaredOperationId'> {
	return {
		group: op.tags && op.tags.length > 0 ? op.tags[0] : DEFAULT_GROUP,
		method,
		pathTemplate,
		summary: typeof op.summary === 'string' ? op.summary : undefined,
		description: typeof op.description === 'string' ? op.description : undefined,
		parameters: mergeParameters(pathItem.parameters, op.parameters),
		requestBody: op.requestBody,
		responses: op.responses ?? {},
	};
}

/**
 * Builds the gateway's operation model for every method of every path in the
 * document.
 *
 * Identity rules (R-ID-1..4): a declared `operationId` is used verbatim;
 * otherwise an ID is derived via {@link deriveOperationId} and collisions are
 * resolved by appending `-2`, `-3`, … Determinism follows from pure iteration
 * over the document's own key order.
 *
 * @param document - A parsed, validated OpenAPI document.
 * @returns One {@link OperationInfo} per recognized method/path combination.
 */
export function buildOperations(document: OpenApiDocument): OperationInfo[] {
	const usedIds = new Set<string>();
	const operations: OperationInfo[] = [];

	for (const [pathTemplate, pathItem] of Object.entries(document.paths)) {
		if (typeof pathItem !== 'object' || pathItem === null) {
			continue;
		}
		for (const method of HTTP_METHODS) {
			const op = pathItem[method];
			if (!op) {
				continue;
			}

			const declared = typeof op.operationId === 'string' && op.operationId.length > 0;
			let operationId = declared
				? (op.operationId as string)
				: deriveOperationId(op.tags && op.tags.length > 0 ? op.tags[0] : DEFAULT_GROUP, method, pathTemplate);
			if (usedIds.has(operationId)) {
				let suffix = 2;
				while (usedIds.has(`${operationId}-${suffix}`)) {
					suffix++;
				}
				operationId = `${operationId}-${suffix}`;
			}

			usedIds.add(operationId);
			operations.push({ ...toOperationInfo(pathItem, pathTemplate, method, op), operationId, declaredOperationId: declared });
		}
	}

	return operations;
}

/**
 * Builds the grouped {@link ApiModel} for one API: operations nested into
 * groups sorted alphabetically, each group carrying its document-level tag
 * description when available (R-DISC-2, R-GRP-*).
 *
 * @param document - The parsed spec providing `tags[].description` metadata.
 * @param operations - Operations produced by {@link buildOperations} for the same document.
 * @returns The grouped model; the single source of truth stored in a snapshot.
 */
export function buildApiModel(document: OpenApiDocument, operations: OperationInfo[]): ApiModel {
	const byName = new Map<string, OperationInfo[]>();
	for (const op of operations) {
		const list = byName.get(op.group);
		if (list) {
			list.push(op);
		} else {
			byName.set(op.group, [op]);
		}
	}
	const groups: OperationGroupModel[] = [...byName.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, groupOps]) => {
			const description = document.tags?.find((tag) => tag.name === name)?.description;
			return { name, description, operations: groupOps };
		});
	return { groups };
}

/**
 * Builds an in-memory index mapping operation ID to operation for one API.
 *
 * Derived from the model at load/refresh time (never persisted), so it cannot
 * drift from the grouped structure. Operation IDs are unique within an API but
 * not across APIs — callers must keep one index per registered API.
 *
 * @param model - Grouped model to flatten.
 * @returns A map usable for O(1) lookups in invocation flows.
 */
export function buildOperationIndex(model: ApiModel): Map<string, OperationInfo> {
	const index = new Map<string, OperationInfo>();
	for (const group of model.groups) {
		for (const op of group.operations) {
			index.set(op.operationId, op);
		}
	}
	return index;
}

/**
 * Resolves a requested set of group names against a model.
 *
 * @param model - Grouped model to search.
 * @param names - One or more requested group names.
 * @returns `found` operations grouped in the order the known names were
 *          requested, and `unknown` listing names with no matching group so
 *          callers can report valid alternatives (spec §4).
 */
export function operationsInGroups(model: ApiModel, names: string[]): { found: OperationInfo[]; unknown: string[] } {
	const found: OperationInfo[] = [];
	const unknown: string[] = [];
	for (const name of names) {
		const group = model.groups.find((g) => g.name === name);
		if (group) {
			found.push(...group.operations);
		} else {
			unknown.push(name);
		}
	}
	return { found, unknown };
}

/**
 * Looks up an operation by its unique ID within one API's index.
 *
 * @param index - Index built by {@link buildOperationIndex} for that API.
 * @param operationId - ID as exposed by the discovery tools.
 * @returns The matching operation, or `undefined` when the ID is unknown.
 */
export function findOperation(index: Map<string, OperationInfo>, operationId: string): OperationInfo | undefined {
	return index.get(operationId);
}
