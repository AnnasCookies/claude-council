import {
  createGoogleAdapter,
  type HttpTransport,
  type ProviderAdapter,
} from '../execution/provider';

export function googleAdapter(transport?: HttpTransport): ProviderAdapter {
  return createGoogleAdapter(transport);
}
