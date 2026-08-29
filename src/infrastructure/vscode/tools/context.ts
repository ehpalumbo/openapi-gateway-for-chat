import {
	ApiRegistry,
	DiscoveryUseCases,
	InvokeOperationUseCase,
	SpillStore,
	TokenStore,
} from '../../../application';

/**
 * Dependencies every gateway tool factory receives.
 */
export interface ToolContext {
	registry: ApiRegistry;
	tokens: TokenStore;
	spills: SpillStore;
	discoveryUseCases: DiscoveryUseCases;
	invokeUseCase: InvokeOperationUseCase;
}
