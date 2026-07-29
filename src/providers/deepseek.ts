import { createHttpAdapter, type HttpTransport, type ProviderAdapter } from '../execution/provider';

export function deepseekAdapter(transport?: HttpTransport): ProviderAdapter {
  return createHttpAdapter(
    {
      family: 'deepseek',
      credential: 'DEEPSEEK_API_KEY',
      endpoint: 'https://api.deepseek.com/chat/completions',
      allowRegistryFallback: true,
    },
    transport,
  );
}
