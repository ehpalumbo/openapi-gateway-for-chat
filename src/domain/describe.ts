/**
 * Description builders for the discovery tools (R-DISC-1..4, R-SCH-1/2).
 *
 * Pure functions over registration snapshots: no `vscode` import, no network
 * I/O. Every returned value is plain JSON-serializable data designed for LLM
 * consumption, so it survives a `JSON.stringify(JSON.parse(...))` round-trip.
 */
import { operationsInGroups } from './operations';
import { collectSchemaRefs, ResolvedSchema, resolveSchemaClosures } from './schema-resolver';
import {
	ApiRegistration,
	HttpMethod,
	JsonSchema,
	OpenApiRequestBody,
	OpenApiResponse,
	OperationInfo,
	OperationParameter,
} from './types';

/**
 * One registered API as listed by `gateway_list_apis`.
 */
export interface ApiSummary {
	apiId: string;
	title: string;
	version: string;
	description?: string;
}

/**
 * Recursively drops `undefined`-valued properties so every builder output is
 * exactly what a JSON round-trip would produce (`assert.deepStrictEqual`
 * distinguishes present-but-undefined keys from absent ones).
 */
function jsonNormalized<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map((item) => jsonNormalized(item)) as unknown as T;
	}
	if (value !== null && typeof value === 'object') {
		const normalized: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			if (child === undefined) {
				continue;
			}
			normalized[key] = jsonNormalized(child);
		}
		return normalized as unknown as T;
	}
	return value;
}

/**
 * @param registrations - All registrations in the registry.
 * @returns One summary per registration (R-DISC-1).
 */
export function buildListApis(registrations: ApiRegistration[]): ApiSummary[] {
	return registrations.map(({ apiId, title, version, snapshot }) =>
		jsonNormalized({
			apiId,
			title,
			version,
			description: snapshot.model.info.description,
		})
	);
}

/**
 * One operation group as listed by `gateway_describe_api`.
 */
export interface GroupSummary {
	name: string;
	description?: string;
	operationCount: number;
}

/**
 * The `gateway_describe_api` payload: API metadata plus its groups
 * straight from the snapshot's model (R-DISC-2).
 */
export interface DescribeApiResult {
	apiId: string;
	title: string;
	version: string;
	description?: string;
	groups: GroupSummary[];
}

/**
 * @param api - Registration to describe.
 * @returns Metadata and group summaries; never an error for a known API.
 */
export function buildDescribeApi({ apiId, title, version, snapshot }: ApiRegistration): DescribeApiResult {
	return jsonNormalized({
		apiId,
		title,
		version,
		description: snapshot.model.info.description,
		groups: snapshot.model.groups.map(({ name, description, operations }) => ({
			name,
			description,
			operationCount: operations.length,
		})),
	});
}

/**
 * One operation as listed by `gateway_list_api_operations`: enough for the agent to
 * decide whether to drill into `describe_operation`, not enough to flood
 * context (R-DISC-3).
 */
export interface OperationSummary {
	operationId: string;
	method: HttpMethod;
	pathTemplate: string;
	group: string;
	summary?: string;
	requiredParameters: string[];
}

/**
 * Result of `gateway_list_api_operations`: always includes the operations found
 * for the matched groups. When one or more requested group names are unrecognised,
 * `unknownGroups` and `availableGroups` are also present so the LLM can
 * self-correct in the same turn without discarding the matched results.
 */
export interface ListOperationsResult {
	/** Operations belonging to the successfully matched groups, in request order. */
	operations: OperationSummary[];
	/**
	 * Group names from the request that did not match any group of this API.
	 * Present (possibly empty) whenever the requested set was empty or contained
	 * at least one unknown name.
	 */
	unknownGroups?: string[];
	/**
	 * All valid group names for this API. Present whenever {@link unknownGroups}
	 * is set, giving the LLM everything it needs to retry with correct names.
	 */
	availableGroups?: string[];
}

/**
 * @param api - Registration whose model is searched.
 * @param groups - Requested group names (zero or more).
 * @returns A result object whose `operations` field always contains the
 *          operations of matched groups. When `groups` is empty or contains
 *          unrecognised names, `unknownGroups` and `availableGroups` are also
 *          set so the caller can surface correction hints to the LLM.
 */
export function buildListOperations(api: ApiRegistration, groups: string[]): ListOperationsResult {
	const { found, unknown } = operationsInGroups(api.snapshot.model, groups);
	const result: ListOperationsResult = {
		operations: found.map(toSummary).map(jsonNormalized),
	};
	if (unknown.length > 0 || groups.length === 0) {
		result.unknownGroups = unknown;
		result.availableGroups = api.snapshot.model.groups.map((g) => g.name);
	}
	return result;
}

function toSummary({ operationId, method, pathTemplate, group, summary, parameters }: OperationInfo): OperationSummary {
	return {
		operationId,
		method,
		pathTemplate,
		group,
		summary,
		requiredParameters: parameters
			.filter((param) => param.required)
			.map(({ name, in: paramIn }) => `${name} (${paramIn})`),
	};
}

/**
 * A parameter description with its spec schema kept inline; parameter schemas
 * may themselves carry refs, which land in {@link DescribeOperationResult.schemas}.
 */
export interface ParameterDescription {
	name: string;
	in: OperationParameter['in'];
	required: boolean;
	description?: string;
	schema?: JsonSchema;
}

/** One media-type entry of a request body or response. */
export interface ContentDescription {
	mediaType: string;
	schema: JsonSchema;
}

/** One response definition keyed by status code. */
export interface ResponseDescription {
	statusCode: string;
	description?: string;
	content: ContentDescription[];
}

/**
 * The `gateway_describe_api_operation` payload: everything an agent needs to build
 * a valid request without further lookups (R-SCH-2). All schemas referenced by
 * parameters, request body, and responses are flattened into {@link schemas}
 * "after each other"; unrelated components are never included (R-SCH-1).
 */
export interface DescribeOperationResult {
	operationId: string;
	method: HttpMethod;
	pathTemplate: string;
	group: string;
	summary?: string;
	description?: string;
	parameters: ParameterDescription[];
	requestBody?: { required: boolean; content: ContentDescription[] };
	responses: ResponseDescription[];
	schemas: ResolvedSchema[];
}

/**
 * @param api - Registration owning the operation.
 * @param operation - The already-resolved {@link OperationInfo} (the caller is
 *          responsible for the index lookup and for returning the appropriate
 *          error when the ID is unknown).
 * @returns The self-contained operation detail.
 * @throws {SchemaResolutionError} When the model references a missing schema
 *          component; treated as a tool-level failure upstream.
 */
export function buildDescribeOperation(
	api: ApiRegistration,
	operation: OperationInfo,
): DescribeOperationResult {
	return jsonNormalized(describeOperation(api, operation));
}

function describeOperation(api: ApiRegistration, operation: OperationInfo): DescribeOperationResult {
	const parameters: ParameterDescription[] =
		operation.parameters.map(({ name, in: paramIn, required, description, schema }) => ({
			name,
			in: paramIn,
			required,
			description,
			schema,
		}));

	const rootRefs: string[] = [];
	for (const param of operation.parameters) {
		collectSchemaRefs(param.schema, rootRefs);
	}

	let requestBody: DescribeOperationResult['requestBody'];
	if (operation.requestBody && hasContentSchemas(operation.requestBody)) {
		requestBody = {
			required: operation.requestBody.required === true,
			content: contentDescriptions(operation.requestBody, rootRefs),
		};
	}

	const responses: ResponseDescription[] = Object.entries(operation.responses ?? {}).map(([statusCode, response]) => ({
		statusCode,
		description: response.description,
		content: contentDescriptions(response, rootRefs),
	}));

	const { operationId, method, pathTemplate, group, summary, description } = operation;
	return {
		operationId,
		method,
		pathTemplate,
		group,
		summary,
		description,
		parameters,
		requestBody,
		responses,
		schemas: rootRefs.length > 0 ? resolveSchemaClosures(api.snapshot.model.schemas, rootRefs) : [],
	};
}

function hasContentSchemas(source: OpenApiRequestBody | OpenApiResponse): boolean {
	return Object.values(source.content ?? {}).some((mediaTypeObject) => mediaTypeObject.schema !== undefined);
}

function contentDescriptions(source: OpenApiRequestBody | OpenApiResponse, rootRefs: string[]): ContentDescription[] {
	const descriptions: ContentDescription[] = [];
	for (const [mediaType, mediaTypeObject] of Object.entries(source.content ?? {})) {
		if (!mediaTypeObject.schema) {
			continue;
		}
		collectSchemaRefs(mediaTypeObject.schema, rootRefs);
		descriptions.push({ mediaType, schema: mediaTypeObject.schema });
	}
	return descriptions;
}
