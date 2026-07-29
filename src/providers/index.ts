import type { ProviderFamily } from '../domain/schemas';
import { type CliTransport, type HttpTransport, type ProviderAdapter } from '../execution/provider';
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
  resolveClaudeExecutable?: () => string | undefined;
  resolveOpenAiExecutable?: () => string | undefined;
  resolveGoogleExecutable?: () => string | undefined;
}

export function createProviderRoster(options: ProviderRosterOptions = {}): ProviderRoster {
  return {
    anthropic: anthropicAdapter(options.cliTransport, options.resolveClaudeExecutable),
    openai: openaiAdapter(options.cliTransport, options.resolveOpenAiExecutable),
    xai: xaiAdapter(options.httpTransport),
    google: googleAdapter(options.cliTransport, options.resolveGoogleExecutable),
    deepseek: deepseekAdapter(options.httpTransport),
    moonshot: moonshotAdapter(options.httpTransport),
  };
}
