import {
  createHttpAdapter,
  openAiCompatibleDialect,
  type HttpTransport,
  type ProviderAdapter,
} from '../execution/provider';

export function moonshotAdapter(transport?: HttpTransport): ProviderAdapter {
  return createHttpAdapter(
    {
      family: 'moonshot',
      credential: 'COUNCIL_MOONSHOT_API_KEY',
      dialect: openAiCompatibleDialect('https://api.moonshot.ai/v1/chat/completions'),
      allowRegistryFallback: false,
    },
    transport,
  );
}
