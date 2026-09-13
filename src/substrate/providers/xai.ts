import {
  createXaiAdapter,
  type ProviderAdapter,
  type XaiAdapterOptions,
} from '../execution/provider';

export function xaiAdapter(options: XaiAdapterOptions = {}): ProviderAdapter {
  return createXaiAdapter(options);
}
