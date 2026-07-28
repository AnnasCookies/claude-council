import { createHttpAdapter, type HttpTransport, type ProviderAdapter } from '../execution/provider';

export function moonshotAdapter(transport?: HttpTransport): ProviderAdapter {
  return createHttpAdapter(
    {
      family: 'moonshot',
      credential: 'MOONSHOT_API_KEY',
      endpoint: 'https://api.moonshot.ai/v1/chat/completions',
      responseKind: 'chat',
      allowRegistryFallback: false,
    },
    transport,
  );
}
