import { beforeEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { loadModelRegistry, type ModelRegistry } from '../../src/models/registry';
import type { CliRequest, CliResult } from '../../src/execution/cli';
import type { HttpRequest, HttpResult, RetryPolicy } from '../../src/execution/http';
import { doctor } from '../../src/health/doctor';
import {
  createOpenAiSubscriptionAdapter,
  type CliTransport,
  type HttpTransport,
  type ProviderContext,
  type ProviderDiagnostic,
  type ProviderRequest,
} from '../../src/execution/provider';
import { createProviderRoster } from '../../src/providers';
import { anthropicAdapter } from '../../src/providers/anthropic-cli';
import { deepseekAdapter } from '../../src/providers/deepseek';
import { googleAdapter } from '../../src/providers/google';
import { moonshotAdapter } from '../../src/providers/moonshot';
import { openaiAdapter } from '../../src/providers/openai';
import { xaiAdapter } from '../../src/providers/xai';

const answer = JSON.stringify({
  recommendation: 'Proceed carefully.',
  evidence: ['The invariant holds.'],
  assumptions: ['Inputs are validated.'],
  risks: ['Provider drift.'],
  uncertainty: 'Low.',
  decisiveTest: 'Run the isolated acceptance path.',
});
const stagedCouncilPrompt =
  'Return exactly one JSON object with these keys: recommendation (string), evidence (string array), assumptions (string array), risks (string array), uncertainty (string), decisiveTest (string). Do not wrap it in prose.\n\nEvaluate the supplied evidence pack.';
const capturedCodexPrompt =
  'Before the final assessment, send a separate progress update as a JSON object matching the required schema; then send the final JSON assessment. The evidence pack is intentionally absent.';
const grokInlineAnswerGuard =
  'IMPORTANT: Respond with your complete answer as plain text directly in this conversation. Do NOT use any tools. Do NOT write, create, or edit any files. Do NOT create artifacts, reports, or documents. Do NOT reference external files. Provide your entire response inline as text.';
const stagedGrokPrompt = `${grokInlineAnswerGuard}\n\n${stagedCouncilPrompt}`;

class FakeHttp implements HttpTransport {
  readonly calls: { request: HttpRequest; policy: RetryPolicy }[] = [];
  constructor(private readonly results: HttpResult[]) {}

  async request(request: HttpRequest, policy: RetryPolicy): Promise<HttpResult> {
    this.calls.push({ request, policy });
    const result = this.results.shift();
    if (!result) throw new Error('fake HTTP result sequence exhausted');
    return result;
  }
}

class FakeCli implements CliTransport {
  readonly calls: CliRequest[] = [];
  constructor(private readonly result: CliResult) {}

  async run(request: CliRequest): Promise<CliResult> {
    this.calls.push(request);
    return this.result;
  }
}

const okHttp = (model: string, content = answer): HttpResult => ({
  status: 'ok',
  attempts: 1,
  statusCode: 200,
  body: { model, choices: [{ message: { content } }] },
  errorCode: null,
  message: '',
});

const ownedDirectory = resolve(tmpdir(), 'council-owned');

const okCli = (stdout: string, workingDirectory = ownedDirectory): CliResult => ({
  status: 'ok',
  executable: process.execPath,
  exitCode: 0,
  stdout,
  stderr: '',
  durationMs: 10,
  treeTerminated: false,
  errorCode: null,
  workingDirectory,
});

function codexCli(
  model: string | undefined,
  content = answer,
  activity: readonly string[] = [],
): CliResult {
  const identity = [
    'OpenAI Codex v0.147.0',
    '--------',
    `workdir: ${ownedDirectory}`,
    ...(model === undefined ? [] : [`model: ${model}`]),
    'provider: openai',
    'approval: never',
    'sandbox: read-only',
    'reasoning effort: xhigh',
    'reasoning summaries: none',
    'session id: 019ff6ae-69a5-7b51-871d-4a22249d0587',
    '--------',
    'user',
    stagedCouncilPrompt,
    ...activity,
    'codex',
    content,
    'tokens used',
    '42',
    '',
  ].join('\n');
  return { ...okCli(content), stderr: identity };
}

interface OmpOutputOptions {
  beforeTerminal?: readonly unknown[];
  terminalContent?: readonly unknown[];
}

const ompOutput = (model: string, content = answer, options: OmpOutputOptions = {}): string => {
  const userMessage = {
    role: 'user',
    content: [{ type: 'text', text: 'staged prompt envelope' }],
  };
  const terminalContent = options.terminalContent ?? [
    { type: 'thinking', thinking: '' },
    { type: 'text', text: content },
  ];
  const assistantMessage = {
    role: 'assistant',
    content: terminalContent,
    provider: 'openai-codex',
    model,
  };
  return [
    { type: 'session', version: 3, id: 'session-1' },
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: userMessage },
    { type: 'message_end', message: userMessage },
    {
      type: 'message_start',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '' }],
        provider: 'openai-codex',
        model,
      },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: '' },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_start', contentIndex: 1 },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_end', contentIndex: 1, content },
    },
    ...(options.beforeTerminal ?? []),
    { type: 'message_end', message: assistantMessage },
    { type: 'turn_end', message: assistantMessage },
    { type: 'agent_end', messages: [userMessage, assistantMessage] },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
};

interface AgyOutputOptions {
  toolName?: string;
  promptPath?: string;
  includePromptPath?: boolean;
  additionalEvents?: readonly unknown[];
  duplicateResult?: boolean;
  resultBeforeRead?: boolean;
  initCwd?: string;
  initTools?: readonly string[];
}

const agyOutput = (model: string, content = answer, options: AgyOutputOptions = {}): string => {
  const toolName = options.toolName ?? 'view_file';
  const parameters =
    options.includePromptPath === false
      ? {}
      : { AbsolutePath: options.promptPath ?? join(ownedDirectory, 'council-prompt.txt') };
  let structuredOutput: unknown;
  try {
    structuredOutput = JSON.parse(content);
  } catch {
    structuredOutput = { invalid: content };
  }
  const result = {
    event: 'result',
    result: { status: 'SUCCESS', response: content, structured_output: structuredOutput },
  };
  const events = [
    {
      event: 'init',
      conversation_id: 'conversation-1',
      init: {
        model,
        cwd: options.initCwd ?? ownedDirectory,
        tools: options.initTools ?? [toolName],
      },
    },
    ...(options.resultBeforeRead ? [result] : []),
    {
      event: 'step_update',
      step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' },
    },
    {
      event: 'step_update',
      step_update: { step_index: 1, state: 'DONE', step_type: 'unknown' },
    },
    {
      event: 'step_update',
      step_update: { step_index: 2, state: 'DONE', step_type: 'agent_response' },
    },
    {
      event: 'step_update',
      step_update: {
        step_index: 3,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: toolName,
        tool_info: { name: toolName, parameters },
      },
    },
    {
      event: 'step_update',
      step_update: {
        step_index: 3,
        state: 'DONE',
        step_type: 'tool',
        tool_name: toolName,
        tool_info: { name: toolName, parameters },
      },
    },
    ...(options.additionalEvents ?? []),
    {
      event: 'step_update',
      step_update: { step_index: 4, state: 'DONE', step_type: 'checkpoint' },
    },
    {
      event: 'step_update',
      step_update: { step_index: 5, state: 'DONE', step_type: 'agent_response' },
    },
    {
      event: 'step_update',
      step_update: { step_index: 6, state: 'DONE', step_type: 'finish' },
    },
    ...(!options.resultBeforeRead ? [result] : []),
    ...(options.duplicateResult ? [result] : []),
  ];
  return events.map((event) => JSON.stringify(event)).join('\n');
};
interface GrokOutputOptions {
  omitInitModel?: boolean;
  contentBlocks?: readonly unknown[];
  apiKeySource?: 'oauth' | 'user';
  permissionMode?: string;
}

function grokMessagesOutput(
  model: string,
  content = answer,
  options: GrokOutputOptions = {},
): string {
  const sessionId = 'grok-session-1';
  const init = {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    apiKeySource: options.apiKeySource ?? 'oauth',
    ...(options.omitInitModel ? {} : { model }),
    cwd: ownedDirectory,
    // Bound to a real grok 1.0.4 init frame observed 2026-08-17: plan mode, and a large advertised
    // capability surface that no flag can empty because auth and MCP config share ~/.grok.
    permissionMode: options.permissionMode ?? 'plan',
    tools: ['read_file', 'grep', 'list_dir'],
    slash_commands: ['/help'],
    mcp_servers: [{ name: 'bc', status: 'connected' }],
    skills: ['some-skill'],
    uuid: 'grok-init-1',
  };
  const assistant = {
    type: 'assistant',
    message: {
      id: 'grok-message-1',
      type: 'message',
      role: 'assistant',
      model,
      content: options.contentBlocks ?? [{ type: 'text', text: content }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: 'grok-assistant-1',
  };
  const result = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 10,
    duration_api_ms: 9,
    num_turns: 1,
    result: content,
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {
      [model]: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
      },
    },
    session_id: sessionId,
    uuid: 'grok-result-1',
  };
  return [init, assistant, result].map((event) => JSON.stringify(event)).join('\n');
}

async function capturedAgyOutput(fixtureName = 'agy-stream-json-success.jsonl'): Promise<string> {
  const fixture = await Bun.file(join(import.meta.dir, 'fixtures', fixtureName)).text();
  const escapedWorkingDirectory = JSON.stringify(ownedDirectory).slice(1, -1);
  const escapedPromptPath = JSON.stringify(join(ownedDirectory, 'council-prompt.txt')).slice(1, -1);
  return fixture
    .replaceAll('__WORKING_DIRECTORY__\\\\council-prompt.txt', escapedPromptPath)
    .replaceAll('__WORKING_DIRECTORY__', escapedWorkingDirectory);
}

async function capturedCodexCli(): Promise<CliResult> {
  const [stderr, stdout] = await Promise.all([
    Bun.file(
      join(import.meta.dir, 'fixtures', 'codex-human-output-multi-message.stderr.txt'),
    ).text(),
    Bun.file(
      join(import.meta.dir, 'fixtures', 'codex-human-output-multi-message.stdout.json'),
    ).text(),
  ]);
  return {
    ...okCli(stdout.trim()),
    stderr: stderr.replace('C:\\tmp\\codexaudit', ownedDirectory),
  };
}

const modelMissing = (): HttpResult => ({
  status: 'failed',
  attempts: 1,
  statusCode: 404,
  body: { error: { message: 'model unavailable' } },
  errorCode: 'model-not-found',
  message: 'HTTP 404',
});

let registry: ModelRegistry;
beforeEach(async () => {
  registry = await loadModelRegistry();
});

function context(
  env: Record<string, string | undefined>,
  diagnostics: ProviderDiagnostic[] = [],
  registryOverride: Partial<ModelRegistry> = {},
): ProviderContext {
  return {
    registry: { ...registry, ...registryOverride },
    env,
    cwd: 'C:/private/project-root',
    timeoutMs: 1_000,
    captureDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  };
}

function request(providerContext: ProviderContext): ProviderRequest {
  return {
    context: providerContext,
    seatId: 'seat-1',
    role: 'critic',
    prompt: 'Evaluate the supplied evidence pack.',
  };
}

describe('provider roster', () => {
  test('constructs exactly one adapter for every governed family', () => {
    const roster = createProviderRoster({ env: {}, resolveXaiExecutable: () => undefined });

    expect(Object.keys(roster)).toEqual([
      'anthropic',
      'openai',
      'xai',
      'google',
      'deepseek',
      'moonshot',
    ]);
    expect(Object.entries(roster).map(([family, adapter]) => [family, adapter.family])).toEqual([
      ['anthropic', 'anthropic'],
      ['openai', 'openai'],
      ['xai', 'xai'],
      ['google', 'google'],
      ['deepseek', 'deepseek'],
      ['moonshot', 'moonshot'],
    ]);
    expect(
      Object.fromEntries(
        Object.entries(roster).map(([family, adapter]) => [family, adapter.transport]),
      ),
    ).toEqual({
      anthropic: 'cli',
      openai: 'subscription-cli',
      xai: 'http',
      google: 'subscription-cli',
      deepseek: 'http',
      moonshot: 'http',
    });
  });
});

describe('HTTP provider adapters', () => {
  test('xAI and Moonshot preserve exact family and actual response identity', async () => {
    const xaiTransport = new FakeHttp([okHttp(registry.xai.primary)]);
    const xaiResponse = await xaiAdapter({
      env: { COUNCIL_XAI_API_KEY: 'test-key' },
      httpTransport: xaiTransport,
      cliTransport: new FakeCli(okCli('')),
      resolveExecutable: () => undefined,
    }).invoke(request(context({ COUNCIL_XAI_API_KEY: 'test-key' })));
    expect(xaiResponse.status).toBe('ok');
    expect(xaiResponse.actualModel).toBe(registry.xai.primary);

    const moonshotTransport = new FakeHttp([okHttp('kimi-k3')]);
    const moonshotResponse = await moonshotAdapter(moonshotTransport).invoke(
      request(context({ COUNCIL_MOONSHOT_API_KEY: 'test-key' })),
    );
    expect(moonshotResponse.status).toBe('ok');
    expect(moonshotResponse.actualModel).toBe('kimi-k3');
  });

  test('DeepSeek fallback remains the same family and is explicit', async () => {
    const transport = new FakeHttp([modelMissing(), okHttp('deepseek-v4-flash')]);
    const response = await deepseekAdapter(transport).invoke(
      request(context({ COUNCIL_DEEPSEEK_API_KEY: 'test-deepseek-key' })),
    );

    expect(response.provider).toBe('deepseek');
    expect(response.requestedModel).toBe('deepseek-v4-pro');
    expect(response.actualModel).toBe('deepseek-v4-flash');
    expect(response.route).toBe('same-provider-fallback');
  });

  test('rejects an HTTPS seat whose response model is outside the configured route', async () => {
    const transport = new FakeHttp([okHttp('deepseek-experimental-preview')]);
    const response = await deepseekAdapter(transport).invoke(
      request(context({ COUNCIL_DEEPSEEK_API_KEY: 'test-deepseek-key' })),
    );

    // `body.model` was extracted and recorded but never compared, so a server-side reroute produced
    // a 'verified' seat for a model outside the route. It is now an integrity failure.
    expect(response.status).toBe('failed');
    if (response.status === 'ok') throw new Error('HTTP route drift unexpectedly succeeded');
    expect(response.error.code).toBe('identity-unverified');
    expect(response.error.retryable).toBe(false);
    expect(response.actualModel).toBe('deepseek-experimental-preview');
    expect(response.modelIdentity).toBe('unverified');
  });

  test('attributes a successful HTTPS seat to the metered credential path', async () => {
    const transport = new FakeHttp([okHttp('deepseek-v4-pro')]);
    const response = await deepseekAdapter(transport).invoke(
      request(context({ COUNCIL_DEEPSEEK_API_KEY: 'test-deepseek-key' })),
    );

    expect(response.status).toBe('ok');
    expect(response.credentialPath).toBe('api-key');
  });

  test('missing credentials skip rather than substitute another family', async () => {
    for (const adapter of [deepseekAdapter, moonshotAdapter]) {
      const response = await adapter(new FakeHttp([])).invoke(request(context({})));
      expect(response.status).toBe('skipped');
      if (response.status === 'ok') throw new Error('missing credential unexpectedly succeeded');
      expect(response.error.code).toBe('missing-credential');
    }
  });

  test('malformed structured output fails and retains only sanitised local diagnostics', async () => {
    const diagnostics: ProviderDiagnostic[] = [];
    const secret = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
    const transport = new FakeHttp([okHttp(registry.xai.primary, `not-json ${secret}`)]);
    const response = await xaiAdapter({
      env: { COUNCIL_XAI_API_KEY: 'test-key' },
      httpTransport: transport,
      cliTransport: new FakeCli(okCli('')),
      resolveExecutable: () => undefined,
    }).invoke(request(context({ COUNCIL_XAI_API_KEY: 'test-key' }, diagnostics)));

    expect(response.status).toBe('failed');
    expect(diagnostics).toHaveLength(1);
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    expect(diagnostics[0]?.rawText).toContain('<SECRET:OPENAI:');
  });
});

describe('xAI automatic transport resolution', () => {
  test('prefers the paid subscription CLI when both the API key and grok executable are present', async () => {
    const http = new FakeHttp([okHttp(registry.xai.primary), okHttp(registry.xai.primary)]);
    const cli = new FakeCli(okCli(grokMessagesOutput(registry.xai.primary)));
    const adapter = xaiAdapter({
      env: { COUNCIL_XAI_API_KEY: 'test-key' },
      httpTransport: http,
      cliTransport: cli,
      resolveExecutable: () => process.execPath,
    });

    const response = await adapter.invoke(request(context({ COUNCIL_XAI_API_KEY: 'test-key' })));

    expect(adapter.transport).toBe('subscription-cli');
    expect(adapter.transportResolution).toEqual({
      preferred: 'subscription-cli',
      effective: 'subscription-cli',
      reason:
        'The grok subscription CLI resolved on PATH and is preferred over the metered API key, which remains available if the subscription is exhausted or unauthenticated.',
    });
    expect(response.status).toBe('ok');
    // The metered key must not be spent while a paid subscription is available.
    expect(http.calls).toHaveLength(0);
  });

  test('falls back to the metered key when the subscription is quota-exhausted', async () => {
    const cli = new FakeCli({
      status: 'failed',
      executable: process.execPath,
      exitCode: 1,
      stdout: '',
      stderr: "ERROR: You've hit your usage limit. Try again at Aug 20th, 2026 9:52 AM.",
      durationMs: 5,
      treeTerminated: false,
      errorCode: 'non-zero-exit',
    });
    const http = new FakeHttp([okHttp(registry.xai.primary)]);
    const response = await xaiAdapter({
      env: { COUNCIL_XAI_API_KEY: 'test-key' },
      httpTransport: http,
      cliTransport: cli,
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({ COUNCIL_XAI_API_KEY: 'test-key' })));

    expect(response.status).toBe('ok');
    expect(response.credentialPath).toBe('api-key');
    expect(response.credentialFallback).toEqual({
      fromTransport: 'subscription-cli',
      toTransport: 'http',
      reason: 'quota-exhausted',
    });
    expect(http.calls).toHaveLength(1);
  });

  test('never falls back to the metered key after an integrity failure', async () => {
    // A drifted model on the subscription path must fail the seat. Retrying it on a second billing
    // path would let a misbehaving transport launder itself into a passing vote, which is worse than
    // a missing one.
    const cli = new FakeCli(okCli(grokMessagesOutput('grok-unapproved')));
    const http = new FakeHttp([okHttp(registry.xai.primary)]);
    const response = await xaiAdapter({
      env: { COUNCIL_XAI_API_KEY: 'test-key' },
      httpTransport: http,
      cliTransport: cli,
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({ COUNCIL_XAI_API_KEY: 'test-key' })));

    expect(response.status).toBe('failed');
    if (response.status === 'ok') throw new Error('integrity failure unexpectedly succeeded');
    expect(response.error.code).toBe('identity-unverified');
    expect(response.credentialFallback).toBeUndefined();
    // The decisive assertion: the metered path was never called.
    expect(http.calls).toHaveLength(0);
  });

  test('api-only refuses to use an available subscription CLI', async () => {
    const cli = new FakeCli(okCli(grokMessagesOutput(registry.xai.primary)));
    const adapter = xaiAdapter({
      env: {},
      httpTransport: new FakeHttp([]),
      cliTransport: cli,
      resolveExecutable: () => process.execPath,
      billingMode: 'api-only',
    });
    const response = await adapter.invoke(request(context({})));

    expect(response.status).toBe('skipped');
    if (response.status === 'ok') throw new Error('api-only unexpectedly used the subscription');
    expect(adapter.transportResolution?.effective).toBeNull();
    expect(response.error.message).toMatch(/api-only requires COUNCIL_XAI_API_KEY/i);
    expect(cli.calls).toHaveLength(0);
  });

  test('sub-only refuses to spend a metered key even when one is set', async () => {
    const http = new FakeHttp([okHttp(registry.xai.primary)]);
    const adapter = xaiAdapter({
      env: { COUNCIL_XAI_API_KEY: 'test-key' },
      httpTransport: http,
      cliTransport: new FakeCli(okCli('')),
      resolveExecutable: () => undefined,
      billingMode: 'sub-only',
    });
    const response = await adapter.invoke(request(context({ COUNCIL_XAI_API_KEY: 'test-key' })));

    expect(response.status).toBe('skipped');
    expect(adapter.transportResolution?.effective).toBeNull();
    expect(http.calls).toHaveLength(0);
  });

  test('honours an explicit HTTPS preference so customer work stays billable', async () => {
    const http = new FakeHttp([okHttp(registry.xai.primary)]);
    const cli = new FakeCli(okCli(grokMessagesOutput(registry.xai.primary)));
    const adapter = xaiAdapter({
      env: { COUNCIL_XAI_API_KEY: 'test-key' },
      httpTransport: http,
      cliTransport: cli,
      resolveExecutable: () => process.execPath,
      transportPreference: 'http',
    });

    const response = await adapter.invoke(request(context({ COUNCIL_XAI_API_KEY: 'test-key' })));

    expect(response.status).toBe('ok');
    expect(adapter.transport).toBe('http');
    expect(adapter.transportResolution?.reason).toBe(
      'HTTPS was explicitly preferred and COUNCIL_XAI_API_KEY is set; the grok subscription CLI was not used.',
    );
    expect(http.calls).toHaveLength(1);
    expect(cli.calls).toHaveLength(0);
  });

  test('selects the subscription CLI when only an absolute grok executable is present', async () => {
    const http = new FakeHttp([]);
    const cli = new FakeCli(okCli(grokMessagesOutput(registry.xai.primary)));
    const adapter = xaiAdapter({
      env: {},
      httpTransport: http,
      cliTransport: cli,
      resolveExecutable: () => process.execPath,
    });

    const response = await adapter.invoke(request(context({})));

    expect(adapter.transport).toBe('subscription-cli');
    expect(adapter.transportResolution).toEqual({
      preferred: 'subscription-cli',
      effective: 'subscription-cli',
      reason: 'The grok subscription CLI resolved on PATH.',
    });
    expect(response.status).toBe('ok');
    expect(response.actualModel).toBe(registry.xai.primary);
    expect(response.modelIdentity).toBe('verified');
    expect(response.route).toBe('primary');
    expect(http.calls).toHaveLength(0);

    const call = cli.calls[0];
    const args = call?.args.map((argument) =>
      typeof argument === 'function' ? argument(ownedDirectory) : argument,
    );
    expect(args).toEqual([
      '--no-auto-update',
      '--prompt-file',
      join(ownedDirectory, 'council-prompt.txt'),
      '--output-format',
      'streaming-messages-json',
      '--sandbox',
      'read-only',
      '--permission-mode',
      'plan',
      '--no-plan',
      '--no-subagents',
      '--no-memory',
      '--disable-web-search',
      '--disallowed-tools',
      'run_terminal_command,write,search_replace,use_tool,search_tool,workflow,monitor,scheduler_create,scheduler_delete,scheduler_list,image_gen,image_edit,image_to_video,reference_to_video',
      '--max-turns',
      '1',
      '--verbatim',
    ]);
    expect(args).not.toContain('Evaluate the supplied evidence pack.');
    expect(call?.stdin).toBe('');
    expect(call?.cwd).toBe(tmpdir());
    expect(call?.files).toEqual({ 'council-prompt.txt': stagedGrokPrompt });
  });

  test('passes a model flag only for an explicit Grok CLI override', async () => {
    const cli = new FakeCli(okCli(grokMessagesOutput(registry.xai.primary)));
    await xaiAdapter({
      env: {},
      httpTransport: new FakeHttp([]),
      cliTransport: cli,
      resolveExecutable: () => process.execPath,
      modelOverride: () => registry.xai.primary,
    }).invoke(request(context({})));

    const args = cli.calls[0]?.args.map((argument) =>
      typeof argument === 'function' ? argument(ownedDirectory) : argument,
    );
    expect(args?.slice(-2)).toEqual(['-m', registry.xai.primary]);
  });

  test('reports both configuration paths when neither transport is available', async () => {
    const adapter = xaiAdapter({
      env: {},
      httpTransport: new FakeHttp([]),
      cliTransport: new FakeCli(okCli('')),
      resolveExecutable: () => undefined,
    });
    const expectedReason =
      'set COUNCIL_XAI_API_KEY in ~/.claude/council/providers.env, or install the grok CLI on PATH';

    expect(adapter.transportResolution).toEqual({
      preferred: 'subscription-cli',
      effective: null,
      reason: expectedReason,
    });
    await expect(adapter.availability(context({}))).resolves.toMatchObject({
      status: 'unconfigured',
      reason: expectedReason,
    });
    const response = await adapter.invoke(request(context({})));
    expect(response.status).toBe('skipped');
    if (response.status === 'ok') throw new Error('unconfigured xAI unexpectedly succeeded');
    expect(response.error.message).toBe(expectedReason);

    const report = await doctor([adapter], context({}), '2026-08-14T00:00:00.000Z');
    expect(report.diagnostics[0]).toMatchObject({
      provider: 'xai',
      transport: 'http',
      status: 'unconfigured',
      detail: expectedReason,
    });
  });

  test('doctor reports the effective CLI transport and why HTTPS was not selected', async () => {
    const adapter = xaiAdapter({
      env: {},
      httpTransport: new FakeHttp([]),
      cliTransport: new FakeCli(okCli(grokMessagesOutput(registry.xai.primary))),
      resolveExecutable: () => process.execPath,
    });

    const report = await doctor([adapter], context({}), '2026-08-14T00:00:00.000Z');

    expect(report.diagnostics[0]).toMatchObject({
      provider: 'xai',
      transport: 'subscription-cli',
      status: 'healthy',
      actualModel: registry.xai.primary,
      identity: 'verified',
      detail: 'The grok subscription CLI resolved on PATH.',
    });
  });

  test('rejects a Grok model outside the governed route as unverified', async () => {
    const response = await xaiAdapter({
      env: {},
      httpTransport: new FakeHttp([]),
      cliTransport: new FakeCli(okCli(grokMessagesOutput('grok-unapproved'))),
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    expect(response.status).toBe('failed');
    if (response.status === 'ok') throw new Error('out-of-route Grok model unexpectedly succeeded');
    expect(response.error.code).toBe('identity-unverified');
    expect(response.actualModel).toBe('grok-unapproved');
    expect(response.modelIdentity).toBe('unverified');
  });

  test('rejects unexpected Grok tool activity', async () => {
    const response = await xaiAdapter({
      env: {},
      httpTransport: new FakeHttp([]),
      cliTransport: new FakeCli(
        okCli(
          grokMessagesOutput(registry.xai.primary, answer, {
            contentBlocks: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'run_terminal_cmd',
                input: { command: 'pwd' },
              },
              { type: 'text', text: answer },
            ],
          }),
        ),
      ),
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    expect(response.status).toBe('failed');
    if (response.status === 'ok')
      throw new Error('tool-bearing Grok output unexpectedly succeeded');
    expect(response.error.code).toBe('unsafe-tool-isolation');
  });

  test('never verifies Grok output without all CLI-owned identity evidence', async () => {
    const response = await xaiAdapter({
      env: {},
      httpTransport: new FakeHttp([]),
      cliTransport: new FakeCli(
        okCli(grokMessagesOutput(registry.xai.primary, answer, { omitInitModel: true })),
      ),
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    expect(response.status).toBe('failed');
    if (response.status === 'ok')
      throw new Error('identity-free Grok output unexpectedly succeeded');
    expect(response.error.code).toBe('identity-unverified');
    expect(response.modelIdentity).not.toBe('verified');
  });

  test('rejects a Grok stream authenticated with an API key as subscription evidence', async () => {
    const response = await xaiAdapter({
      env: {},
      httpTransport: new FakeHttp([]),
      cliTransport: new FakeCli(
        okCli(grokMessagesOutput(registry.xai.primary, answer, { apiKeySource: 'user' })),
      ),
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    expect(response.status).toBe('failed');
    if (response.status === 'ok') throw new Error('API-key Grok stream unexpectedly succeeded');
    expect(response.error.code).toBe('identity-unverified');
    expect(response.actualModel).toBe(registry.xai.primary);
    expect(response.modelIdentity).toBe('unverified');
  });

  test('classifies Grok timeout and non-zero exit without retrying either', async () => {
    const cases = [
      [
        {
          ...okCli(''),
          status: 'timed-out',
          exitCode: null,
          errorCode: 'timeout',
          treeTerminated: true,
        },
        'timed-out',
        'timeout',
      ],
      [
        { ...okCli(''), status: 'failed', exitCode: 1, errorCode: 'non-zero-exit' },
        'failed',
        'non-zero-exit',
      ],
    ] as const;

    for (const [result, expectedStatus, expectedCode] of cases) {
      const cli = new FakeCli(result);
      const response = await xaiAdapter({
        env: {},
        httpTransport: new FakeHttp([]),
        cliTransport: cli,
        resolveExecutable: () => process.execPath,
      }).invoke(request(context({})));
      expect(response.status).toBe(expectedStatus);
      if (response.status === 'ok')
        throw new Error('failing Grok invocation unexpectedly succeeded');
      expect(response.error.code).toBe(expectedCode);
      expect(cli.calls).toHaveLength(1);
    }
  });
});

describe('Subscription CLI provider adapters', () => {
  test('OpenAI builds a direct Codex invocation with the isolated prompt and answer schema', async () => {
    const transport = new FakeCli(codexCli('gpt-5.6-sol'));
    await openaiAdapter({
      cliTransport: transport,
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    const call = transport.calls[0];
    const args = call?.args.map((argument) =>
      typeof argument === 'function' ? argument(ownedDirectory) : argument,
    );
    expect(args).toEqual([
      'exec',
      '--skip-git-repo-check',
      '--strict-config',
      '--model',
      'gpt-5.6-sol',
      '--output-schema',
      join(ownedDirectory, 'council-answer-schema.json'),
      '--sandbox',
      'read-only',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '-c',
      // The seat must set reasoning effort explicitly: --ignore-user-config would otherwise
      // leave Codex at `reasoning effort: none`.
      'model_reasoning_effort="xhigh"',
      '-c',
      'web_search="disabled"',
      '--disable',
      'shell_tool',
      '--disable',
      'unified_exec',
      '--disable',
      'browser_use',
      '--disable',
      'browser_use_external',
      '--disable',
      'browser_use_full_cdp_access',
      '--disable',
      'computer_use',
      '--disable',
      'view_image',
      '--disable',
      'image_generation',
      '--disable',
      'apps',
      '--disable',
      'plugins',
      '--disable',
      'remote_plugin',
      '--disable',
      'multi_agent',
      '--disable',
      'hooks',
      '--disable',
      'skill_search',
      '--disable',
      'skill_mcp_dependency_install',
      '--disable',
      'workspace_dependencies',
      '--color',
      'never',
      '-',
    ]);
    expect(args?.join(' ')).not.toContain('Evaluate the supplied evidence pack.');
    const promptFile = call?.files?.['council-prompt.txt'];
    if (typeof promptFile !== 'string') throw new Error('staged council prompt missing');
    expect(promptFile).toContain('Evaluate the supplied evidence pack.');
    expect(call?.stdin).toBe(promptFile);
    expect(JSON.parse(String(call?.files?.['council-answer-schema.json']))).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: [
        'recommendation',
        'evidence',
        'assumptions',
        'risks',
        'uncertainty',
        'decisiveTest',
      ],
    });
  });

  test('OpenAI accepts a structured Codex answer with verified runtime identity', async () => {
    const response = await openaiAdapter({
      cliTransport: new FakeCli(codexCli('gpt-5.6-sol')),
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    if (response.status !== 'ok') throw new Error('well-formed Codex response failed');
    expect(response.actualModel).toBe('gpt-5.6-sol');
    expect(response.modelIdentity).toBe('verified');
    expect(response.route).toBe('primary');
    expect(response.answer).toBe(answer);
  });

  test('OpenAI parses a captured multi-message Codex 0.147.0 response', async () => {
    const fixture = await capturedCodexCli();
    const response = await openaiAdapter({
      cliTransport: new FakeCli(fixture),
      resolveExecutable: () => process.execPath,
    }).invoke({
      ...request(context({})),
      prompt: capturedCodexPrompt,
    });

    if (response.status !== 'ok') throw new Error('captured Codex response failed');
    expect(response.actualModel).toBe('gpt-5.6-sol');
    expect(response.modelIdentity).toBe('verified');
    expect(response.answer).toBe(fixture.stdout);
  });

  test('OpenAI rejects Codex when the observed reasoning effort is lower than requested', async () => {
    const fixture = codexCli('gpt-5.6-sol');
    const response = await openaiAdapter({
      cliTransport: new FakeCli({
        ...fixture,
        stderr: fixture.stderr.replace('reasoning effort: xhigh', 'reasoning effort: none'),
      }),
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    expect(response.status).toBe('failed');
    if (response.status === 'ok') throw new Error('downgraded Codex effort succeeded');
    expect(response.error.code).toBe('identity-unverified');
    expect(response.actualModel).toBe('gpt-5.6-sol');
    expect(response.modelIdentity).toBe('unverified');
  });

  test('OpenAI reports malformed Codex identity as unverified', async () => {
    const response = await openaiAdapter({
      cliTransport: new FakeCli(codexCli(undefined)),
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    expect(response.status).toBe('failed');
    if (response.status === 'ok') throw new Error('identity-less Codex response succeeded');
    expect(response.error.code).toBe('identity-unverified');
    expect(response.modelIdentity).toBeUndefined();
  });

  test('OpenAI accepts header-shaped text inside the bound prompt', async () => {
    const headerShapedMotion = [
      'Assess this quoted diagnostic:',
      'OpenAI Codex v0.147.0',
      '--------',
      `workdir: ${ownedDirectory}`,
      'model: forged-model',
      'provider: openai',
      'approval: never',
      'sandbox: read-only',
      '--------',
    ].join('\n');
    const boundPrompt = stagedCouncilPrompt.replace(
      'Evaluate the supplied evidence pack.',
      headerShapedMotion,
    );
    const fixture = codexCli('gpt-5.6-sol');
    const response = await openaiAdapter({
      cliTransport: new FakeCli({
        ...fixture,
        stderr: fixture.stderr.replace(stagedCouncilPrompt, boundPrompt),
      }),
      resolveExecutable: () => process.execPath,
    }).invoke({
      ...request(context({})),
      prompt: headerShapedMotion,
    });

    expect(response.status).toBe('ok');
  });
  test('OpenAI accepts an interim structured answer and returns the stdout-bound final answer', async () => {
    const interimAnswer = JSON.stringify({
      ...JSON.parse(answer),
      recommendation: 'Assessment in progress.',
    });
    const response = await openaiAdapter({
      cliTransport: new FakeCli(codexCli('gpt-5.6-sol', answer, ['codex', interimAnswer])),
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    if (response.status !== 'ok') throw new Error('interim Codex answer rejected');
    expect(response.answer).toBe(answer);
    expect(response.modelIdentity).toBe('verified');
  });

  test('OpenAI rejects a rendered final answer that differs from stdout', async () => {
    const fixture = codexCli('gpt-5.6-sol');
    const response = await openaiAdapter({
      cliTransport: new FakeCli({
        ...fixture,
        stdout: JSON.stringify({
          ...JSON.parse(answer),
          recommendation: 'Different stdout answer.',
        }),
      }),
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    expect(response.status).toBe('failed');
    if (response.status === 'ok') throw new Error('unbound Codex stdout succeeded');
    expect(response.error.code).toBe('identity-unverified');
  });

  test('OpenAI accepts a warning before the unique renderer identity header', async () => {
    const fixture = codexCli('gpt-5.6-sol');
    const response = await openaiAdapter({
      cliTransport: new FakeCli({
        ...fixture,
        stderr: `WARNING: unable to create optional PATH aliases\n${fixture.stderr}`,
      }),
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    expect(response.status).toBe('ok');
  });

  test('OpenAI rejects a Codex tool trace even when it precedes the first answer', async () => {
    const response = await openaiAdapter({
      cliTransport: new FakeCli(
        codexCli('gpt-5.6-sol', answer, [
          'exec',
          'powershell -Command Get-Location',
          'succeeded in 10ms:',
        ]),
      ),
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    expect(response.status).toBe('failed');
    if (response.status === 'ok') throw new Error('tool-bearing Codex response succeeded');
    expect(response.error.code).toBe('unsafe-tool-isolation');
    expect(response.actualModel).toBe('gpt-5.6-sol');
  });
  test('OpenAI normalises Windows prompt line endings before verifying the transcript', async () => {
    const windowsMotion = 'Evaluate\r\nthe supplied evidence pack.';
    const windowsPrompt = stagedCouncilPrompt.replace(
      'Evaluate the supplied evidence pack.',
      windowsMotion,
    );
    const response = await openaiAdapter({
      cliTransport: new FakeCli({
        ...codexCli('gpt-5.6-sol'),
        stderr: codexCli('gpt-5.6-sol').stderr.replace(stagedCouncilPrompt, windowsPrompt),
      }),
      resolveExecutable: () => process.execPath,
    }).invoke({
      ...request(context({})),
      prompt: windowsMotion,
    });

    expect(response.status).toBe('ok');
  });

  test('OpenAI accepts a pretty multiline answer with Windows output line endings', async () => {
    const prettyAnswer = JSON.stringify(JSON.parse(answer), null, 2);
    const response = await openaiAdapter({
      cliTransport: new FakeCli({
        ...codexCli('gpt-5.6-sol', prettyAnswer),
        stdout: prettyAnswer.replace(/\n/g, '\r\n'),
      }),
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    expect(response.status).toBe('ok');
  });

  test('OpenAI rejects unrecognised text between the prompt and final answer', async () => {
    const response = await openaiAdapter({
      cliTransport: new FakeCli(codexCli('gpt-5.6-sol', answer, ['read_file: council-prompt.txt'])),
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    expect(response.status).toBe('failed');
    if (response.status === 'ok') throw new Error('unrecognised Codex activity succeeded');
    expect(response.error.code).toBe('identity-unverified');
  });

  test('OpenAI rejects rendered Codex non-shell tools and model reroutes', async () => {
    for (const activity of [
      ['web search: https://example.com'],
      ['mcp: server/tool started'],
      ['apply patch', 'patch: completed'],
      ['collab: spawn_agent'],
      ['hook: SessionStart'],
      ['model rerouted: gpt-5.6-sol -> gpt-5.6-mini'],
    ]) {
      const response = await openaiAdapter({
        cliTransport: new FakeCli(codexCli('gpt-5.6-sol', answer, activity)),
        resolveExecutable: () => process.execPath,
      }).invoke(request(context({})));

      expect(response.status).toBe('failed');
      if (response.status === 'ok') throw new Error('unsafe Codex transcript succeeded');
      expect(response.error.code).toBe(
        activity[0]?.startsWith('model rerouted:')
          ? 'identity-unverified'
          : 'unsafe-tool-isolation',
      );
    }
  });

  test('legacy OMP OpenAI transport uses an isolated profile and tool-free arguments', async () => {
    const transport = new FakeCli(okCli(ompOutput('gpt-5.6-sol')));
    const response = await createOpenAiSubscriptionAdapter(
      transport,
      () => process.execPath,
      () => undefined,
    ).invoke(request(context({})));

    expect(response.status).toBe('ok');
    expect(response.actualModel).toBe('gpt-5.6-sol');
    expect(response.route).toBe('primary');
    const call = transport.calls[0];
    expect(call?.args).toEqual(
      expect.arrayContaining([
        '--profile',
        'claude-council',
        '--model',
        'openai-codex/gpt-5.6-sol',
        '--no-tools',
        '--no-extensions',
        '--no-skills',
        '--no-rules',
        '--no-session',
        '--config',
        '@council-prompt.txt',
      ]),
    );
    expect(call?.args.join(' ')).not.toContain('Evaluate the supplied evidence pack.');
    expect(call?.stdin).toBe('');
    expect(call?.files?.['council-prompt.txt']).toContain('Evaluate the supplied evidence pack.');
    const overlayArgument = call?.args[(call?.args.indexOf('--config') ?? -2) + 1];
    if (typeof overlayArgument !== 'function') throw new Error('OMP isolation overlay missing');
    expect(call?.files?.['omp-isolation.yml']).toBe(
      [
        'advisor:',
        '  enabled: false',
        'prewalk:',
        '  enabled: false',
        'disabledProviders:',
        '  - native',
        '  - claude',
        '  - codex',
        '  - gemini',
        '  - opencode',
        '  - github',
        '  - agents',
        '  - agents-md',
      ].join('\n'),
    );
    expect(call?.cwd).not.toContain('C:/private/project-root');
  });

  test('legacy OMP transport ignores prompt-bearing aggregates without structured output', async () => {
    const diagnostics: ProviderDiagnostic[] = [];
    const secretPrompt = 'private motion must not be retained';
    const transport = new FakeCli(
      okCli(
        JSON.stringify({
          type: 'agent_end',
          messages: [{ role: 'user', content: [{ type: 'text', text: secretPrompt }] }],
        }),
      ),
    );

    const response = await createOpenAiSubscriptionAdapter(
      transport,
      () => process.execPath,
      () => undefined,
    ).invoke(request(context({}, diagnostics)));

    expect(response.status).toBe('failed');
    expect(JSON.stringify(response)).not.toContain(secretPrompt);
    expect(JSON.stringify(diagnostics)).not.toContain(secretPrompt);
  });

  test('legacy OMP transport rejects malformed, duplicate and tool-bearing streams', async () => {
    const cases = [
      [`${ompOutput('gpt-5.6-sol')}\n{"type":`, 'identity-unverified'],
      [`${ompOutput('gpt-unapproved')}\n${ompOutput('gpt-5.6-sol')}`, 'identity-unverified'],
      [`${ompOutput('gpt-5.6-sol')}\n${ompOutput('gpt-5.6-sol')}`, 'identity-unverified'],
      [
        ompOutput('gpt-5.6-sol', answer, {
          beforeTerminal: [{ type: 'tool_execution_start', toolName: 'browser_get_dom' }],
        }),
        'unsafe-tool-isolation',
      ],
      [
        ompOutput('gpt-5.6-sol', answer, {
          terminalContent: [
            { type: 'thinking', thinking: '' },
            { type: 'toolCall', name: 'read' },
            { type: 'text', text: answer },
          ],
        }),
        'unsafe-tool-isolation',
      ],
    ] as const;

    for (const [output, errorCode] of cases) {
      const response = await createOpenAiSubscriptionAdapter(
        new FakeCli(okCli(output)),
        () => process.execPath,
        () => undefined,
      ).invoke(request(context({})));
      expect(response.status).toBe('failed');
      if (response.status === 'ok') throw new Error('invalid OMP stream unexpectedly succeeded');
      expect(response.error.code).toBe(errorCode);
    }
  });

  test('Google uses AGY with one allowed prompt-file read in an isolated home', async () => {
    const transport = new FakeCli(okCli(agyOutput('gemini-3.1-pro-high')));
    const response = await googleAdapter({
      cliTransport: transport,
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    expect(response.status).toBe('ok');
    expect(response.actualModel).toBe('gemini-3.1-pro-high');
    const call = transport.calls[0];
    const workingDirectory = ownedDirectory;
    const args = call?.args.map((argument) =>
      typeof argument === 'function' ? argument(workingDirectory) : argument,
    );
    expect(args).toEqual(
      expect.arrayContaining([
        '--sandbox',
        '--mode',
        'plan',
        '--output-format',
        'stream-json',
        '--model',
        'gemini-3.1-pro-high',
        '-p',
      ]),
    );
    expect(args?.join(' ')).not.toContain('Evaluate the supplied evidence pack.');
    expect(args?.join(' ')).toContain(join(workingDirectory, 'council-prompt.txt'));
    expect(call?.stdin).toBe('');
    expect(call?.workingDirectoryEnv).toEqual(['HOME', 'USERPROFILE']);
    expect(call?.files?.['council-prompt.txt']).toContain('Evaluate the supplied evidence pack.');
    const settingsValue = call?.files?.['.gemini/antigravity-cli/settings.json'];
    if (typeof settingsValue !== 'function') throw new Error('dynamic AGY settings missing');
    expect(JSON.parse(settingsValue(workingDirectory))).toEqual({
      enableTelemetry: false,
      trustedWorkspaces: [workingDirectory],
      permissions: {
        allow: [`read_file(${join(workingDirectory, 'council-prompt.txt')})`],
      },
    });
  });

  test('Google verifies the model identity in captured AGY stream-json output', async () => {
    const response = await googleAdapter({
      cliTransport: new FakeCli(okCli(await capturedAgyOutput())),
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    expect(response.status).toBe('ok');
    expect(response.actualModel).toBe('gemini-3.1-pro-high');
    expect(response.modelIdentity).toBe('verified');
  });

  test('Google verifies captured long-motion AGY stream-json output', async () => {
    const response = await googleAdapter({
      cliTransport: new FakeCli(
        okCli(await capturedAgyOutput('agy-stream-json-long-motion.jsonl')),
      ),
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    expect(response.status).toBe('ok');
    expect(response.actualModel).toBe('gemini-3.1-pro-high');
    expect(response.modelIdentity).toBe('verified');
  });

  test('Google rejects captured AGY output when the init model identity is absent', async () => {
    const [initLine, ...remainingLines] = (await capturedAgyOutput()).trimEnd().split(/\r?\n/);
    if (!initLine) throw new Error('captured AGY fixture has no init event');
    const initEvent = JSON.parse(initLine) as { init: { model?: string } };
    delete initEvent.init.model;
    const withoutIdentity = [JSON.stringify(initEvent), ...remainingLines].join('\n');
    const adapter = googleAdapter({
      cliTransport: new FakeCli(okCli(withoutIdentity)),
      resolveExecutable: () => process.execPath,
    });
    const response = await adapter.invoke(request(context({})));
    const report = await doctor([adapter], context({}), '2026-08-12T00:00:00.000Z');

    expect(response.status).toBe('failed');
    if (response.status === 'ok') {
      throw new Error('identity-free AGY stream unexpectedly succeeded');
    }
    expect(response.error.code).toBe('identity-unverified');
    expect(response.actualModel).toBeUndefined();
    expect(response.modelIdentity).toBeUndefined();
    expect(report.diagnostics[0]).toMatchObject({
      provider: 'google',
      actualModel: null,
      identity: 'unverified',
      status: 'identity-unverified',
      errorCategory: 'identity-unverified',
    });
  });

  test('Google rejects a model identity that differs from the requested route', async () => {
    const actualModel = 'gemini-3.6-flash-high';
    const output = agyOutput(actualModel);
    const response = await googleAdapter({
      cliTransport: new FakeCli(okCli(output)),
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    expect(response.status).toBe('failed');
    if (response.status === 'ok') throw new Error('rerouted AGY run succeeded');
    expect(response.error.code).toBe('identity-unverified');
    expect(response.actualModel).toBe(actualModel);
    expect(response.modelIdentity).toBe('unverified');

    const health = await googleAdapter({
      cliTransport: new FakeCli(okCli(output)),
      resolveExecutable: () => process.execPath,
    }).probe(context({}));
    expect(health.status).toBe('identity-unverified');
    expect(health.actualModel).toBe(actualModel);

    const report = await doctor(
      [
        googleAdapter({
          cliTransport: new FakeCli(okCli(output)),
          resolveExecutable: () => process.execPath,
        }),
      ],
      context({}),
      '2026-07-29T00:00:00.000Z',
    );
    expect(report.diagnostics[0]?.actualModel).toBe(actualModel);
    expect(report.diagnostics[0]?.remediationCodes).toContain('review-route-drift');
  });

  test('Google retains verified identity when the answer schema is invalid', async () => {
    const response = await googleAdapter({
      cliTransport: new FakeCli(okCli(agyOutput('gemini-3.1-pro-high', 'not-json'))),
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    expect(response.status).toBe('failed');
    if (response.status === 'ok') throw new Error('invalid answer unexpectedly succeeded');
    expect(response.error.code).toBe('invalid-structured-answer');
    expect(response.actualModel).toBe('gemini-3.1-pro-high');
    expect(response.modelIdentity).toBe('verified');
    expect(response.route).toBe('primary');

    const report = await doctor(
      [
        googleAdapter({
          cliTransport: new FakeCli(okCli(agyOutput('gemini-3.1-pro-high', 'not-json'))),
          resolveExecutable: () => process.execPath,
        }),
      ],
      context({}),
      '2026-07-29T00:00:00.000Z',
    );
    expect(report.diagnostics[0]?.actualModel).toBe('gemini-3.1-pro-high');
  });

  test('Google ignores unrecognised intermediate events', async () => {
    const output = agyOutput('gemini-3.1-pro-high', answer, {
      additionalEvents: [
        {
          event: 'step_update',
          step_update: { step_index: 7, state: 'DONE', step_type: 'network' },
        },
        {
          event: 'usage_update',
          usage_update: { input_tokens: 3_007 },
        },
      ],
    });
    const response = await googleAdapter({
      cliTransport: new FakeCli(okCli(output)),
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    expect(response.status).toBe('ok');
    expect(response.modelIdentity).toBe('verified');
  });

  test('Google rejects malformed, unowned and duplicate tool streams', async () => {
    const malformedExtraTool = {
      event: 'step_update',
      step_update: {
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'browser_get_dom',
        tool_info: {},
      },
    };
    const subagent = {
      event: 'step_update',
      step_update: { state: 'DONE', step_type: 'subagent' },
    };
    const disguisedTool = {
      event: 'step_update',
      step_update: {
        step_index: 7,
        state: 'DONE',
        step_type: 'unknown',
        tool_name: 'browser_get_dom',
        tool_info: {},
      },
    };
    const cases = [
      [
        agyOutput('gemini-3.1-pro-high', answer, { includePromptPath: false }),
        'unsafe-tool-isolation',
      ],
      [
        agyOutput('gemini-3.1-pro-high', answer, {
          promptPath: join(ownedDirectory, '..', 'other', 'council-prompt.txt'),
        }),
        'unsafe-tool-isolation',
      ],
      [
        agyOutput('gemini-3.1-pro-high', answer, {
          promptPath: relative(ownedDirectory, join(ownedDirectory, 'council-prompt.txt')),
        }),
        'unsafe-tool-isolation',
      ],
      [agyOutput('gemini-3.1-pro-high', answer, { resultBeforeRead: true }), 'identity-unverified'],
      [
        agyOutput('gemini-3.1-pro-high', answer, {
          initCwd: join(ownedDirectory, '..', 'other'),
        }),
        'unsafe-tool-isolation',
      ],
      [agyOutput('gemini-3.1-pro-high', answer, { initTools: [] }), 'unsafe-tool-isolation'],
      [
        agyOutput('gemini-3.1-pro-high', answer, {
          additionalEvents: [malformedExtraTool],
        }),
        'unsafe-tool-isolation',
      ],
      [
        agyOutput('gemini-3.1-pro-high', answer, { additionalEvents: [subagent] }),
        'unsafe-tool-isolation',
      ],
      [
        agyOutput('gemini-3.1-pro-high', answer, { additionalEvents: [disguisedTool] }),
        'unsafe-tool-isolation',
      ],
      [agyOutput('gemini-3.1-pro-high', answer, { duplicateResult: true }), 'identity-unverified'],
    ] as const;

    for (const [output, errorCode] of cases) {
      const response = await googleAdapter({
        cliTransport: new FakeCli(okCli(output)),
        resolveExecutable: () => process.execPath,
      }).invoke(request(context({})));
      expect(response.status).toBe('failed');
      if (response.status === 'ok') throw new Error('invalid AGY stream unexpectedly succeeded');
      expect(response.error.code).toBe(errorCode);
    }
  });

  test('Google tool-policy drift is reported as unsafe isolation', async () => {
    const unsafeOutput = agyOutput('gemini-3.1-pro-high', answer, {
      toolName: 'browser_get_dom',
    });
    const health = await googleAdapter({
      cliTransport: new FakeCli(okCli(unsafeOutput)),
      resolveExecutable: () => process.execPath,
    }).probe(context({}));
    expect(health.status).toBe('unsafe-transport');

    const report = await doctor(
      [
        googleAdapter({
          cliTransport: new FakeCli(okCli(unsafeOutput)),
          resolveExecutable: () => process.execPath,
        }),
      ],
      context({}),
      '2026-07-29T00:00:00.000Z',
    );
    expect(report.diagnostics[0]?.toolIsolation).toBe('unsupported');
    expect(report.diagnostics[0]?.remediationCodes).toContain('secure-transport');
  });

  test('legacy OMP transport reports an absent governed profile without invocation', async () => {
    const transport = new FakeCli(okCli(ompOutput('gpt-5.6-sol')));
    const adapter = createOpenAiSubscriptionAdapter(
      transport,
      () => process.execPath,
      () => 'OMP profile claude-council is not configured',
    );

    const availability = await adapter.availability(context({}));
    const response = await adapter.invoke(request(context({})));

    expect(availability.status).toBe('unconfigured');
    expect(response.status).toBe('skipped');
    if (response.status === 'ok') throw new Error('absent OMP profile unexpectedly succeeded');
    expect(response.error.code).toBe('missing-subscription-profile');
    expect(transport.calls).toHaveLength(0);
  });

  test('subscription CLI trust-root rejection is reported as unsafe transport', async () => {
    const rejectedCli: CliResult = {
      ...okCli(''),
      status: 'failed',
      exitCode: null,
      errorCode: 'repository-executable',
    };
    const health = await openaiAdapter({
      cliTransport: new FakeCli(rejectedCli),
      resolveExecutable: () => process.execPath,
    }).probe(context({}));
    expect(health.status).toBe('unsafe-transport');

    const report = await doctor(
      [
        openaiAdapter({
          cliTransport: new FakeCli(rejectedCli),
          resolveExecutable: () => process.execPath,
        }),
      ],
      context({}),
      '2026-07-29T00:00:00.000Z',
    );
    expect(report.diagnostics[0]?.toolIsolation).toBe('unsupported');
    expect(report.diagnostics[0]?.remediationCodes).toContain('secure-transport');
  });

  test('missing subscription executables skip instead of falling back to API keys', async () => {
    const adapters = [
      openaiAdapter({
        cliTransport: new FakeCli(okCli('')),
        resolveExecutable: () => undefined,
      }),
      googleAdapter({
        cliTransport: new FakeCli(okCli('')),
        resolveExecutable: () => undefined,
      }),
    ];
    for (const adapter of adapters) {
      const response = await adapter.invoke(
        request(context({ OPENAI_API_KEY: 'unused', GEMINI_API_KEY: 'unused' })),
      );
      expect(response.status).toBe('skipped');
      if (response.status === 'ok') throw new Error('missing executable unexpectedly succeeded');
      expect(response.error.code).toMatch(
        /^missing-(executable|anthropic-transport|openai-transport|google-transport|xai-transport)$/,
      );
    }
  });
});

describe('metered API wire shapes', () => {
  // These pin the request each vendor actually documents. They exist because the first version of
  // the Gemini dialect sent the Python SDK's snake_case `response_mime_type` /
  // `response_json_schema`, which the REST API ignores — constrained decoding would have been
  // silently off with every fixture test still green.
  test('Anthropic Messages uses output_config.format and the documented headers', async () => {
    const http = new FakeHttp([
      {
        status: 'ok',
        attempts: 1,
        statusCode: 200,
        body: {
          model: 'claude-opus-5',
          content: [{ type: 'text', text: answer }],
          usage: { input_tokens: 120, output_tokens: 45 },
        },
        errorCode: null,
        message: '',
      },
    ]);
    const response = await anthropicAdapter({
      env: { COUNCIL_ANTHROPIC_API_KEY: 'test-key' },
      httpTransport: http,
      resolveExecutable: () => undefined,
      billingMode: 'api-only',
    }).invoke(request(context({ COUNCIL_ANTHROPIC_API_KEY: 'test-key' })));

    expect(response.status).toBe('ok');
    expect(response.actualModel).toBe('claude-opus-5');
    expect(response.credentialPath).toBe('api-key');
    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 45 });

    const call = http.calls[0];
    expect(call?.request.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call?.request.headers?.['x-api-key']).toBe('test-key');
    expect(call?.request.headers?.['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(call?.request.body));
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema.additionalProperties).toBe(false);
    // Omitted, not an empty array: no tools requested means none granted.
    expect('tools' in body).toBe(false);
  });

  test('Gemini generateContent uses camelCase generationConfig keys', async () => {
    const http = new FakeHttp([
      {
        status: 'ok',
        attempts: 1,
        statusCode: 200,
        body: {
          modelVersion: 'gemini-3.1-pro-high',
          candidates: [{ content: { parts: [{ text: answer }] } }],
          usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 60 },
        },
        errorCode: null,
        message: '',
      },
    ]);
    const response = await googleAdapter({
      env: { COUNCIL_GEMINI_API_KEY: 'test-key' },
      httpTransport: http,
      resolveExecutable: () => undefined,
      billingMode: 'api-only',
    }).invoke(request(context({ COUNCIL_GEMINI_API_KEY: 'test-key' })));

    expect(response.status).toBe('ok');
    expect(response.actualModel).toBe('gemini-3.1-pro-high');
    expect(response.usage).toEqual({ inputTokens: 200, outputTokens: 60 });

    const call = http.calls[0];
    // The model is named in the path, not the body.
    expect(call?.request.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-high:generateContent',
    );
    expect(call?.request.headers?.['x-goog-api-key']).toBe('test-key');
    const body = JSON.parse(String(call?.request.body));
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseJsonSchema.type).toBe('object');
    // The snake_case forms are Python-SDK only and are ignored on the wire.
    expect('response_mime_type' in body.generationConfig).toBe(false);
    expect('response_json_schema' in body.generationConfig).toBe(false);
  });

  test('a metered Gemini seat outside the configured route still fails closed', async () => {
    const http = new FakeHttp([
      {
        status: 'ok',
        attempts: 1,
        statusCode: 200,
        body: {
          modelVersion: 'gemini-3.9-experimental',
          candidates: [{ content: { parts: [{ text: answer }] } }],
        },
        errorCode: null,
        message: '',
      },
    ]);
    const response = await googleAdapter({
      env: { COUNCIL_GEMINI_API_KEY: 'test-key' },
      httpTransport: http,
      resolveExecutable: () => undefined,
      billingMode: 'api-only',
    }).invoke(request(context({ COUNCIL_GEMINI_API_KEY: 'test-key' })));

    // Gemini resolves aliases server-side, so route drift on this path is realistic rather than
    // hypothetical, and the metered path must verify identity exactly as the CLI path does.
    expect(response.status).toBe('failed');
    if (response.status === 'ok') throw new Error('gemini route drift unexpectedly succeeded');
    expect(response.error.code).toBe('identity-unverified');
    expect(response.modelIdentity).toBe('unverified');
  });

  test('an Anthropic response with no text block has no answer to accept', async () => {
    const http = new FakeHttp([
      {
        status: 'ok',
        attempts: 1,
        statusCode: 200,
        body: {
          model: 'claude-opus-5',
          content: [{ type: 'tool_use' }],
        },
        errorCode: null,
        message: '',
      },
    ]);
    const response = await anthropicAdapter({
      env: { COUNCIL_ANTHROPIC_API_KEY: 'test-key' },
      httpTransport: http,
      resolveExecutable: () => undefined,
      billingMode: 'api-only',
    }).invoke(request(context({ COUNCIL_ANTHROPIC_API_KEY: 'test-key' })));

    // An empty join would look like a malformed answer from a model that actually declined.
    expect(response.status).toBe('failed');
    if (response.status === 'ok') throw new Error('text-free response unexpectedly succeeded');
    expect(response.error.code).toBe('invalid-provider-response');
  });
});

describe('Anthropic CLI adapter', () => {
  test('uses a trusted absolute executable with tool-free stateless arguments', async () => {
    const transport = new FakeCli({
      status: 'ok',
      executable: process.execPath,
      exitCode: 0,
      stdout: JSON.stringify({ result: answer, modelUsage: { 'claude-opus-5': {} } }),
      stderr: '',
      durationMs: 10,
      treeTerminated: false,
      errorCode: null,
    });
    const response = await anthropicAdapter({
      cliTransport: transport,
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    expect(response.status).toBe('ok');
    expect(response.actualModel).toBe('claude-opus-5');
    expect(transport.calls[0]?.args).toEqual(
      expect.arrayContaining([
        '--model',
        'claude-opus-5',
        '--safe-mode',
        '--no-session-persistence',
        '--tools',
        '',
      ]),
    );
    expect(transport.calls[0]?.stdin).toContain('Evaluate the supplied evidence pack.');
    expect(transport.calls[0]?.cwd).not.toContain('C:/private/project-root');
  });

  test('constrains decoding with the native council schema, not prose alone', async () => {
    // Observed live: with prose-only instructions this seat failed a real motion with
    // `invalid-structured-answer` while still passing the trivial health prompt, so the regression
    // would have been invisible to `doctor`.
    const transport = new FakeCli({
      status: 'ok',
      executable: process.execPath,
      exitCode: 0,
      stdout: JSON.stringify({ result: answer, modelUsage: { 'claude-opus-5': {} } }),
      stderr: '',
      durationMs: 10,
      treeTerminated: false,
      errorCode: null,
    });
    await anthropicAdapter({
      cliTransport: transport,
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    const args = transport.calls[0]?.args ?? [];
    const schemaIndex = args.indexOf('--json-schema');
    expect(schemaIndex).toBeGreaterThanOrEqual(0);
    const rawSchema = args[schemaIndex + 1];
    // `args` may hold cwd-resolving thunks as well as literals; the schema must be a literal, and a
    // thunk here would mean the schema was late-bound rather than fixed.
    expect(typeof rawSchema).toBe('string');
    const schema = JSON.parse(typeof rawSchema === 'string' ? rawSchema : '{}');
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      'assumptions',
      'decisiveTest',
      'evidence',
      'recommendation',
      'risks',
      'uncertainty',
    ]);
  });

  test('records the requested effort without claiming the provider attested it', async () => {
    const transport = new FakeCli({
      status: 'ok',
      executable: process.execPath,
      exitCode: 0,
      stdout: JSON.stringify({ result: answer, modelUsage: { 'claude-opus-5': {} } }),
      stderr: '',
      durationMs: 10,
      treeTerminated: false,
      errorCode: null,
    });
    const response = await anthropicAdapter({
      cliTransport: transport,
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    expect(response.status).toBe('ok');
    expect(transport.calls[0]?.args).toEqual(expect.arrayContaining(['--effort', 'max']));
    expect(response.requestedEffort).toBe('max');
    // The claude CLI reports no effort in its JSON, so echoing 'max' back would fabricate an
    // attestation. Absence here is the honest answer.
    expect(response.observedEffort).toBeUndefined();
    expect(response.credentialPath).toBe('subscription');
  });

  test('rejects a responding model outside the configured route', async () => {
    const transport = new FakeCli({
      status: 'ok',
      executable: process.execPath,
      exitCode: 0,
      stdout: JSON.stringify({ result: answer, modelUsage: { 'claude-haiku-9': {} } }),
      stderr: '',
      durationMs: 10,
      treeTerminated: false,
      errorCode: null,
    });
    const response = await anthropicAdapter({
      cliTransport: transport,
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    // Previously this returned status 'ok' with modelIdentity 'verified' and route 'primary' for a
    // model nobody selected, because the primary-absent branch fell back to the first key.
    expect(response.status).toBe('failed');
    if (response.status === 'ok') throw new Error('route drift unexpectedly succeeded');
    expect(response.error.code).toBe('identity-unverified');
    expect(response.error.retryable).toBe(false);
    expect(response.actualModel).toBe('claude-haiku-9');
    expect(response.modelIdentity).toBe('unverified');
  });

  test('accepts the auxiliary model the CLI really bills alongside the requested one', async () => {
    // Observed live from claude 2.x: a tool-free `-p --model claude-opus-5` run bills
    // `claude-haiku-4-5-20251001` as well, because Claude Code uses a small model for its own
    // background work. An earlier version of this guard treated any multi-key `modelUsage` as
    // unattributable, which made the one always-present seat fail on every real call.
    const transport = new FakeCli({
      status: 'ok',
      executable: process.execPath,
      exitCode: 0,
      stdout: JSON.stringify({
        result: answer,
        modelUsage: { 'claude-haiku-4-5-20251001': {}, 'claude-opus-5': {} },
      }),
      stderr: '',
      durationMs: 10,
      treeTerminated: false,
      errorCode: null,
    });
    const response = await anthropicAdapter({
      cliTransport: transport,
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    expect(response.status).toBe('ok');
    expect(response.actualModel).toBe('claude-opus-5');
    expect(response.route).toBe('primary');
  });

  test('rejects a turn that billed no model from the configured route', async () => {
    const transport = new FakeCli({
      status: 'ok',
      executable: process.execPath,
      exitCode: 0,
      stdout: JSON.stringify({
        result: answer,
        modelUsage: { 'claude-haiku-4-5-20251001': {}, 'claude-sonnet-9': {} },
      }),
      stderr: '',
      durationMs: 10,
      treeTerminated: false,
      errorCode: null,
    });
    const response = await anthropicAdapter({
      cliTransport: transport,
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({})));

    // Auxiliary billing is fine; an answer with no configured model behind it is not.
    expect(response.status).toBe('failed');
    if (response.status === 'ok') throw new Error('off-route usage unexpectedly succeeded');
    expect(response.error.code).toBe('identity-unverified');
    expect(response.error.message).toMatch(/billed no model from the configured route/i);
    expect(response.modelIdentity).toBe('unverified');
  });

  test('rejects a turn that billed two models from the configured route', async () => {
    const transport = new FakeCli({
      status: 'ok',
      executable: process.execPath,
      exitCode: 0,
      stdout: JSON.stringify({
        result: answer,
        modelUsage: { 'claude-opus-5': {}, 'claude-opus-5-mini': {} },
      }),
      stderr: '',
      durationMs: 10,
      treeTerminated: false,
      errorCode: null,
    });
    const response = await anthropicAdapter({
      cliTransport: transport,
      resolveExecutable: () => process.execPath,
      // A registry whose fallback is also billed makes the responder genuinely ambiguous.
    }).invoke(
      request(
        context({}, undefined, {
          anthropic: {
            primary: 'claude-opus-5',
            fallbacks: ['claude-opus-5-mini'],
            transport: 'cli',
          },
        }),
      ),
    );

    expect(response.status).toBe('failed');
    if (response.status === 'ok') throw new Error('ambiguous route usage unexpectedly succeeded');
    expect(response.error.code).toBe('identity-unverified');
    expect(response.error.message).toMatch(/more than one model from the configured route/i);
  });

  test('sanitises CLI stderr before returning or retaining it', async () => {
    const diagnostics: ProviderDiagnostic[] = [];
    const secret = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
    const transport = new FakeCli({
      status: 'failed',
      executable: process.execPath,
      exitCode: 1,
      stdout: '',
      stderr: `provider rejected ${secret}`,
      durationMs: 10,
      treeTerminated: false,
      errorCode: 'non-zero-exit',
    });

    const response = await anthropicAdapter({
      cliTransport: transport,
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({}, diagnostics)));

    expect(response.status).toBe('failed');
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(JSON.stringify(response)).toContain('<SECRET:OPENAI:');
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    expect(diagnostics[0]?.rawText).toContain('<SECRET:OPENAI:');
  });

  test('missing executable returns skipped', async () => {
    const transport = new FakeCli({
      status: 'failed',
      executable: '',
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: 0,
      treeTerminated: false,
      errorCode: 'executable-not-found',
    });
    const response = await anthropicAdapter({
      cliTransport: transport,
      resolveExecutable: () => undefined,
    }).invoke(request(context({})));
    expect(response.status).toBe('skipped');
    if (response.status === 'ok') throw new Error('missing executable unexpectedly succeeded');
    expect(response.error.code).toMatch(
      /^missing-(executable|anthropic-transport|openai-transport|google-transport|xai-transport)$/,
    );
  });
});
