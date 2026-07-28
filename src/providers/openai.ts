import { createHttpAdapter, type HttpTransport, type ProviderAdapter } from '../execution/provider';

export function openaiAdapter(transport?: HttpTransport): ProviderAdapter {
  return createHttpAdapter(
    {
      family: 'openai',
      credential: 'OPENAI_API_KEY',
      endpoint: 'https://api.openai.com/v1/responses',
      responseKind: 'openai-responses',
      allowRegistryFallback: false,
    },
    transport,
  );
}
