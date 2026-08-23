/**
 * Operation identity (R-ID-*) and grouping (R-GRP-*).
 *
 * All functions are pure and deterministic: the same document always yields
 * the same operation IDs and groups, across activations and refreshes.
 */
import { HTTP_METHODS, HttpMethod, OpenApiDocument, OpenApiOperation, OpenApiParameter, OperationGroup, OperationInfo, OperationParameter } from './types';

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
 * Aggregates operations into named groups sorted alphabetically, as exposed by
 * `gateway_describe_api` (R-GRP-2).
 *
 * @param operations - Operations produced by {@link buildOperations}.
 * @returns One entry per distinct group name with its operation count.
 */
export function groupOperations(operations: OperationInfo[]): OperationGroup[] {
	const counts = new Map<string, number>();
	for (const op of operations) {
		counts.set(op.group, (counts.get(op.group) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, operationCount]) => ({ name, operationCount }));
}

/**
 * Looks up an operation by its unique ID within one API.
 *
 * @param operations - Operations to search.
 * @param operationId - ID as exposed by the discovery tools.
 * @returns The matching operation, or `undefined` when the ID is unknown.
 */
export function findOperation(operations: OperationInfo[], operationId: string): OperationInfo | undefined {
	return operations.find((op) => op.operationId === operationId);
}
