import {
  createHttpAdapter,
  openAiCompatibleDialect,
  type HttpTransport,
  type ProviderAdapter,
} from '../execution/provider';

export function deepseekAdapter(transport?: HttpTransport): ProviderAdapter {
  return createHttpAdapter(
    {
      family: 'deepseek',
      credential: 'COUNCIL_DEEPSEEK_API_KEY',
      dialect: openAiCompatibleDialect('https://api.deepseek.com/chat/completions'),
      allowRegistryFallback: true,
    },
    transport,
  );
}
