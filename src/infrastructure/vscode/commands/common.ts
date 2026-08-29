import {
	ApiRegistry,
	RefreshApisUseCase,
	RegisterApiUseCase,
	SpecLoader,
	TokenStore,
	UnregisterApiUseCase,
} from '../../../application';

/**
 * Dependencies shared by all command handlers.
 */
export interface CommandContext {
	registry: ApiRegistry;
	tokens: TokenStore;
	specLoader: SpecLoader;
	registerUseCase: RegisterApiUseCase;
	unregisterUseCase: UnregisterApiUseCase;
	refreshUseCase: RefreshApisUseCase;
	/** Invoked after every mutation so tools re-register. */
	onChange: () => void;
}
