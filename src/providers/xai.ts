import { createHttpAdapter, type HttpTransport, type ProviderAdapter } from '../execution/provider';

export function xaiAdapter(transport?: HttpTransport): ProviderAdapter {
  return createHttpAdapter(
    {
      family: 'xai',
      credential: 'XAI_API_KEY',
      endpoint: 'https://api.x.ai/v1/chat/completions',
      responseKind: 'chat',
      allowRegistryFallback: false,
    },
    transport,
  );
}
