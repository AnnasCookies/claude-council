import {
  createOpenAiSubscriptionAdapter,
  type CliTransport,
  type ProviderAdapter,
} from '../execution/provider';

export function openaiAdapter(
  transport?: CliTransport,
  resolveExecutable?: () => string | undefined,
  profileConfigurationError?: () => string | undefined,
): ProviderAdapter {
  return createOpenAiSubscriptionAdapter(transport, resolveExecutable, profileConfigurationError);
}
