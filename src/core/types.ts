/**
 * Domain types shared across the extension's core layer.
 *
 * Everything in this module is pure data with no dependency on the VS Code API,
 * so it can be unit-tested in isolation (see NFR-6 in the software specification).
 */

/**
 * The HTTP methods the gateway recognizes in OpenAPI `paths` entries.
 */
export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/**
 * An HTTP method supported by OpenAPI path items.
 */
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Type guard checking whether a string is one of the known HTTP methods.
 *
 * @param value - Arbitrary string, typically a key of a path-item object.
 * @returns `true` when `value` is an {@link HttpMethod}.
 */
export function isHttpMethod(value: string): value is HttpMethod {
	return (HTTP_METHODS as readonly string[]).includes(value);
}

/**
 * The subset of the OpenAPI `info` object the gateway relies on.
 */
export interface OpenApiInfo {
	/** Human-readable API title. */
	title: string;
	/** API version declared by the document author. */
	version: string;
	/** Optional longer description of the API. */
	description?: string;
}

/**
 * A loose representation of a JSON schema used for parameters and bodies.
 * Kept untyped because OpenAPI allows arbitrary schema keywords.
 */
export type JsonSchema = Record<string, unknown>;

/**
 * The subset of an OpenAPI parameter object the gateway exposes to agents.
 */
export interface OpenApiParameter {
	/** Parameter name as declared in the spec. */
	name: string;
	/** Parameter location (`path`, `query`, `header`, or `cookie`). */
	in: 'path' | 'query' | 'header' | 'cookie';
	/** Whether the parameter must be provided; defaults to `false` except for path params. */
	required?: boolean;
	/** Optional human-readable description. */
	description?: string;
	/** Optional JSON schema describing accepted values. */
	schema?: JsonSchema;
}

/**
 * A single media-type entry (e.g. under `requestBody.content['application/json']`).
 */
export interface OpenApiMediaType {
	/** Schema describing payloads of this media type. */
	schema?: JsonSchema;
}

/**
 * The subset of an OpenAPI request-body object the gateway uses.
 */
export interface OpenApiRequestBody {
	/** Optional description of the body. */
	description?: string;
	/** Whether the body is mandatory for the operation. */
	required?: boolean;
	/** Media types accepted by the operation. */
	content?: Record<string, OpenApiMediaType>;
}

/**
 * The subset of an OpenAPI response object the gateway uses.
 */
export interface OpenApiResponse {
	/** Optional description of the response. */
	description?: string;
	/** Media types returned for this status code. */
	content?: Record<string, OpenApiMediaType>;
}

/**
 * Responses of an operation keyed by status code or pattern (`200`, `4XX`, `default`).
 */
export type OpenApiResponses = Record<string, OpenApiResponse>;

/**
 * The subset of an OpenAPI operation object the gateway uses.
 */
export interface OpenApiOperation {
	/** Explicit operation identifier from the spec, when present. */
	operationId?: string;
	/** Tags declared on the operation; the first tag determines its group. */
	tags?: string[];
	/** Short one-line summary. */
	summary?: string;
	/** Longer operation description. */
	description?: string;
	/** Whether the spec marks the operation deprecated. */
	deprecated?: boolean;
	/** Operation-level parameters. */
	parameters?: OpenApiParameter[];
	/** Request-body definition, when the operation accepts a body. */
	requestBody?: OpenApiRequestBody;
	/** Response definitions keyed by status code. */
	responses?: OpenApiResponses;
}

/**
 * The subset of an OpenAPI server object the gateway uses.
 */
export interface OpenApiServer {
	/** Base URL template; variables are not expanded by the MVP. */
	url: string;
	/** Optional description of the server environment. */
	description?: string;
}

/**
 * A path-item entry that carries non-method fields such as shared parameters.
 */
export interface OpenApiPathItem {
	/** Parameters shared by every operation on this path. */
	parameters?: OpenApiParameter[];
}

/**
 * A parsed, validated OpenAPI 3.0.x / 3.1.x document.
 *
 * Only the fields consumed by the gateway are modeled; unknown fields are
 * preserved at runtime but intentionally not typed.
 */
export interface OpenApiDocument {
	/** Declared OpenAPI version, guaranteed to match 3.0.x or 3.1.x after validation. */
	openapi: string;
	/** Required info block. */
	info: OpenApiInfo;
	/** Servers declared by the document, if any. */
	servers?: OpenApiServer[];
	/** Document-level tag definitions, if any. */
	tags?: { name: string; description?: string }[];
	/** Operations grouped by path template. */
	paths: Record<string, OpenApiPathItem & Partial<Record<HttpMethod, OpenApiOperation>>>;
	/** Reusable components; only schemas are relevant for `$ref` resolution. */
	components?: { schemas?: Record<string, JsonSchema> };
}

/**
 * Where a registered API's spec came from, so refresh can re-fetch or re-read it.
 */
export type SpecSource =
	| { kind: 'url'; url: string }
	| { kind: 'file'; fsPath: string };

/**
 * An operation enriched with the derived identity and grouping the tools expose.
 */
export interface OperationParameter extends OpenApiParameter {
	/** Always `true` for path parameters; otherwise mirrors the spec declaration. */
	required: boolean;
}

/**
 * One invocable operation of a registered API, with identity resolved per R-ID-*.
 */
export interface OperationInfo {
	/** Unique ID within the API: verbatim `operationId` or derived kebab-case form. */
	operationId: string;
	/** Whether {@link operationId} was declared explicitly in the spec. */
	declaredOperationId: boolean;
	/** Group name: the operation's first tag, or `default` when untagged. */
	group: string;
	/** Lowercase HTTP method. */
	method: HttpMethod;
	/** Path template including `{variable}` placeholders. */
	pathTemplate: string;
	/** Short summary from the spec. */
	summary?: string;
	/** Longer description from the spec. */
	description?: string;
	/** Effective parameters (path-item level merged with operation level). */
	parameters: OperationParameter[];
	/** Request-body definition, when the operation accepts a body. */
	requestBody?: OpenApiRequestBody;
	/** Response definitions keyed by status code. */
	responses: OpenApiResponses;
}

/**
 * A named group of operations, as exposed by `gateway_describe_api`.
 */
export interface OperationGroup {
	/** Group name: first tag or `default`. */
	name: string;
	/** Number of operations in the group. */
	operationCount: number;
}

/**
 * The last successfully parsed state of an API's spec, kept so registrations
 * stay usable when a later refresh fails (R-REG-7).
 */
export interface ApiSnapshot {
	/** Parsed document backing the snapshot. */
	document: OpenApiDocument;
	/** Derived operations of {@link document}. */
	operations: OperationInfo[];
	/** Groups derived from {@link operations}. */
	groups: OperationGroup[];
}

/**
 * A user-registered API: metadata, invocation base URL, spec source, and the
 * last-good snapshot used by all discovery and invocation tools.
 */
export interface ApiRegistration {
	/** Unique, user-chosen identifier (R-REG-8). */
	apiId: string;
	/** Title copied from the spec's `info.title` at registration time. */
	title: string;
	/** Version copied from the spec's `info.version` at registration time. */
	version: string;
	/** Base URL selected at registration time; all requests target it exclusively (R-REG-9, R-INV-4). */
	baseUrl: string;
	/** Origin of the spec so refresh can re-fetch/re-read it (R-REG-6). */
	source: SpecSource;
	/** Last-good parse of the spec. */
	snapshot: ApiSnapshot;
}
