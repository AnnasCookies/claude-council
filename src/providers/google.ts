import {
  createGoogleDualAdapter,
  type DualCredentialAdapterOptions,
  type ProviderAdapter,
} from '../execution/provider';

export function googleAdapter(options: DualCredentialAdapterOptions = {}): ProviderAdapter {
  return createGoogleDualAdapter(options);
}
