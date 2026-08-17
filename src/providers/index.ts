import type { ProviderFamily } from '../domain/schemas';
import {
  DEFAULT_BILLING_MODE,
  type BillingMode,
  type CliTransport,
  type HttpTransport,
  type ProviderAdapter,
} from '../execution/provider';
import { anthropicAdapter } from './anthropic-cli';
import { deepseekAdapter } from './deepseek';
import { googleAdapter } from './google';
import { moonshotAdapter } from './moonshot';
import { openaiAdapter } from './openai';
import { xaiAdapter } from './xai';

export type ProviderRoster = Readonly<Record<ProviderFamily, ProviderAdapter>>;

export interface ProviderRosterOptions {
  httpTransport?: HttpTransport;
  cliTransport?: CliTransport;
  env?: Readonly<Record<string, string | undefined>>;
  resolveClaudeExecutable?: () => string | undefined;
  resolveOpenAiExecutable?: () => string | undefined;
  resolveXaiExecutable?: () => string | undefined;
  xaiModelOverride?: () => string | undefined;
  xaiTransportPreference?: 'http' | 'subscription-cli';
  resolveGoogleExecutable?: () => string | undefined;
  /**
   * Applied to every dual-credential family, so one run cannot mix a subscription seat with a
   * metered one. Per-family billing would make a single motion partly billable and partly not, which
   * is exactly the attribution ambiguity the mode exists to remove.
   */
  billingMode?: BillingMode;
}

export function createProviderRoster(options: ProviderRosterOptions = {}): ProviderRoster {
  const billingMode = options.billingMode ?? DEFAULT_BILLING_MODE;
  return {
    anthropic: anthropicAdapter({
      env: options.env,
      httpTransport: options.httpTransport,
      cliTransport: options.cliTransport,
      resolveExecutable: options.resolveClaudeExecutable,
      billingMode,
    }),
    openai: openaiAdapter({
      env: options.env,
      httpTransport: options.httpTransport,
      cliTransport: options.cliTransport,
      resolveExecutable: options.resolveOpenAiExecutable,
      billingMode,
    }),
    xai: xaiAdapter({
      env: options.env,
      httpTransport: options.httpTransport,
      cliTransport: options.cliTransport,
      resolveExecutable: options.resolveXaiExecutable,
      modelOverride: options.xaiModelOverride,
      transportPreference: options.xaiTransportPreference,
      billingMode,
    }),
    google: googleAdapter({
      env: options.env,
      httpTransport: options.httpTransport,
      cliTransport: options.cliTransport,
      resolveExecutable: options.resolveGoogleExecutable,
      billingMode,
    }),
    deepseek: deepseekAdapter(options.httpTransport),
    moonshot: moonshotAdapter(options.httpTransport),
  };
}
