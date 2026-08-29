import { HeaderValue, PathParamValue, QueryParamValue } from '../../domain';

/**
 * Agent-supplied input values for one operation invocation (R-INV-2).
 */
export interface InvokeOperationInput {
	apiId: string;
	operationId: string;
	pathParams?: Record<string, PathParamValue>;
	queryParams?: Record<string, QueryParamValue>;
	headers?: Record<string, HeaderValue>;
	body?: Record<string, unknown> | unknown[] | string;
}
