import {
  createOpenAiDualAdapter,
  type DualCredentialAdapterOptions,
  type ProviderAdapter,
} from '../execution/provider';

export function openaiAdapter(options: DualCredentialAdapterOptions = {}): ProviderAdapter {
  return createOpenAiDualAdapter(options);
}
