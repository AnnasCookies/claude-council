import {
  createAnthropicDualAdapter,
  type DualCredentialAdapterOptions,
  type ProviderAdapter,
} from '../execution/provider';

export function anthropicAdapter(options: DualCredentialAdapterOptions = {}): ProviderAdapter {
  return createAnthropicDualAdapter(options);
}
