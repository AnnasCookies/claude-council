import {
  createAnthropicAdapter,
  type CliTransport,
  type ProviderAdapter,
} from '../execution/provider';

export function anthropicAdapter(
  transport?: CliTransport,
  resolveExecutable?: () => string | undefined,
): ProviderAdapter {
  return createAnthropicAdapter(transport, resolveExecutable);
}
