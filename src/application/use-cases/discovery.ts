import {
	ApiSummary,
	buildDescribeApi,
	buildDescribeOperation,
	buildListApis,
	buildListOperations,
	DescribeApiResult,
	DescribeOperationResult,
	ListOperationsResult,
} from '../../domain';
import { ApiRegistry, RegistryEntry } from '../ports';

export type DiscoveryResult<T> =
	| { kind: 'success'; data: T }
	| { kind: 'no_apis' }
	| { kind: 'unknown_api'; apiId: string; availableApis: string[] }
	| { kind: 'unknown_operation'; operationId: string; availableOperations: string[] };

export class DiscoveryUseCases {
	constructor(private readonly registry: ApiRegistry) { }

	listApis(): DiscoveryResult<{ apis: ApiSummary[] }> {
		const registrations = this.registry.list();
		if (registrations.length === 0) {
			return { kind: 'no_apis' };
		}
		return {
			kind: 'success',
			data: { apis: buildListApis(registrations) },
		};
	}

	describeApi(apiId: string): DiscoveryResult<DescribeApiResult> {
		const entry = this.resolveEntry(apiId);
		if ('kind' in entry) {
			return entry;
		}
		return {
			kind: 'success',
			data: buildDescribeApi(entry.registration),
		};
	}

	listOperations(apiId: string, groups: string[]): DiscoveryResult<ListOperationsResult> {
		const entry = this.resolveEntry(apiId);
		if ('kind' in entry) {
			return entry;
		}
		return {
			kind: 'success',
			data: buildListOperations(entry.registration, groups),
		};
	}

	describeOperation(apiId: string, operationId: string): DiscoveryResult<DescribeOperationResult> {
		const entry = this.resolveEntry(apiId);
		if ('kind' in entry) {
			return entry;
		}
		const operation = entry.index.get(operationId);
		if (!operation) {
			return {
				kind: 'unknown_operation',
				operationId,
				availableOperations: [...entry.index.keys()],
			};
		}
		return {
			kind: 'success',
			data: buildDescribeOperation(entry.registration, operation),
		};
	}

	private resolveEntry(apiId: string): RegistryEntry | DiscoveryResult<never> {
		if (this.registry.list().length === 0) {
			return { kind: 'no_apis' };
		}
		const entry = this.registry.getEntry(apiId);
		if (!entry) {
			return {
				kind: 'unknown_api',
				apiId,
				availableApis: this.registry.list().map((reg) => reg.apiId),
			};
		}
		return entry;
	}
}
