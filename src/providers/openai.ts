import {
  createOpenAiCodexAdapter,
  type CliTransport,
  type ProviderAdapter,
} from '../execution/provider';

export function openaiAdapter(
  transport?: CliTransport,
  resolveExecutable?: () => string | undefined,
): ProviderAdapter {
  return createOpenAiCodexAdapter(transport, resolveExecutable);
}
