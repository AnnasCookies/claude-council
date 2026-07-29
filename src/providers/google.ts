import {
  createGoogleSubscriptionAdapter,
  type CliTransport,
  type ProviderAdapter,
} from '../execution/provider';

export function googleAdapter(
  transport?: CliTransport,
  resolveExecutable?: () => string | undefined,
): ProviderAdapter {
  return createGoogleSubscriptionAdapter(transport, resolveExecutable);
}
