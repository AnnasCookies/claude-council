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
  const result = {
    event: 'result',
    result: { status: 'SUCCESS', response: content },
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

async function capturedAgyOutput(): Promise<string> {
  const fixture = await Bun.file(
    join(import.meta.dir, 'fixtures', 'agy-stream-json-success.jsonl'),
  ).text();
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
): ProviderContext {
  return {
    registry,
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
    const roster = createProviderRoster();

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
    for (const [adapter, key, model] of [
      [xaiAdapter, 'XAI_API_KEY', 'grok-4.5'],
      [moonshotAdapter, 'MOONSHOT_API_KEY', 'kimi-k3'],
    ] as const) {
      const transport = new FakeHttp([okHttp(model)]);
      const response = await adapter(transport).invoke(request(context({ [key]: 'test-key' })));
      expect(response.status).toBe('ok');
      expect(response.actualModel).toBe(model);
    }
  });

  test('DeepSeek fallback remains the same family and is explicit', async () => {
    const transport = new FakeHttp([modelMissing(), okHttp('deepseek-v4-flash')]);
    const response = await deepseekAdapter(transport).invoke(
      request(context({ DEEPSEEK_API_KEY: 'test-deepseek-key' })),
    );

    expect(response.provider).toBe('deepseek');
    expect(response.requestedModel).toBe('deepseek-v4-pro');
    expect(response.actualModel).toBe('deepseek-v4-flash');
    expect(response.route).toBe('same-provider-fallback');
  });

  test('missing credentials skip rather than substitute another family', async () => {
    for (const adapter of [xaiAdapter, deepseekAdapter, moonshotAdapter]) {
      const response = await adapter(new FakeHttp([])).invoke(request(context({})));
      expect(response.status).toBe('skipped');
      if (response.status === 'ok') throw new Error('missing credential unexpectedly succeeded');
      expect(response.error.code).toBe('missing-credential');
    }
  });

  test('malformed structured output fails and retains only sanitised local diagnostics', async () => {
    const diagnostics: ProviderDiagnostic[] = [];
    const secret = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
    const transport = new FakeHttp([okHttp('grok-4.5', `not-json ${secret}`)]);
    const response = await xaiAdapter(transport).invoke(
      request(context({ XAI_API_KEY: 'test-key' }, diagnostics)),
    );

    expect(response.status).toBe('failed');
    expect(diagnostics).toHaveLength(1);
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    expect(diagnostics[0]?.rawText).toContain('<SECRET:OPENAI:');
  });
});

describe('Subscription CLI provider adapters', () => {
  test('OpenAI builds a direct Codex invocation with the isolated prompt and answer schema', async () => {
    const transport = new FakeCli(codexCli('gpt-5.6-sol'));
    await openaiAdapter(transport, () => process.execPath).invoke(request(context({})));

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
    const response = await openaiAdapter(
      new FakeCli(codexCli('gpt-5.6-sol')),
      () => process.execPath,
    ).invoke(request(context({})));

    if (response.status !== 'ok') throw new Error('well-formed Codex response failed');
    expect(response.actualModel).toBe('gpt-5.6-sol');
    expect(response.modelIdentity).toBe('verified');
    expect(response.route).toBe('primary');
    expect(response.answer).toBe(answer);
  });

  test('OpenAI parses a captured multi-message Codex 0.147.0 response', async () => {
    const fixture = await capturedCodexCli();
    const response = await openaiAdapter(new FakeCli(fixture), () => process.execPath).invoke({
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
    const response = await openaiAdapter(
      new FakeCli({
        ...fixture,
        stderr: fixture.stderr.replace('reasoning effort: xhigh', 'reasoning effort: none'),
      }),
      () => process.execPath,
    ).invoke(request(context({})));

    expect(response.status).toBe('failed');
    if (response.status === 'ok') throw new Error('downgraded Codex effort succeeded');
    expect(response.error.code).toBe('identity-unverified');
    expect(response.actualModel).toBe('gpt-5.6-sol');
    expect(response.modelIdentity).toBe('unverified');
  });

  test('OpenAI reports malformed Codex identity as unverified', async () => {
    const response = await openaiAdapter(
      new FakeCli(codexCli(undefined)),
      () => process.execPath,
    ).invoke(request(context({})));

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
    const response = await openaiAdapter(
      new FakeCli({
        ...fixture,
        stderr: fixture.stderr.replace(stagedCouncilPrompt, boundPrompt),
      }),
      () => process.execPath,
    ).invoke({
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
    const response = await openaiAdapter(
      new FakeCli(codexCli('gpt-5.6-sol', answer, ['codex', interimAnswer])),
      () => process.execPath,
    ).invoke(request(context({})));

    if (response.status !== 'ok') throw new Error('interim Codex answer rejected');
    expect(response.answer).toBe(answer);
    expect(response.modelIdentity).toBe('verified');
  });

  test('OpenAI rejects a rendered final answer that differs from stdout', async () => {
    const fixture = codexCli('gpt-5.6-sol');
    const response = await openaiAdapter(
      new FakeCli({
        ...fixture,
        stdout: JSON.stringify({
          ...JSON.parse(answer),
          recommendation: 'Different stdout answer.',
        }),
      }),
      () => process.execPath,
    ).invoke(request(context({})));

    expect(response.status).toBe('failed');
    if (response.status === 'ok') throw new Error('unbound Codex stdout succeeded');
    expect(response.error.code).toBe('identity-unverified');
  });

  test('OpenAI accepts a warning before the unique renderer identity header', async () => {
    const fixture = codexCli('gpt-5.6-sol');
    const response = await openaiAdapter(
      new FakeCli({
        ...fixture,
        stderr: `WARNING: unable to create optional PATH aliases\n${fixture.stderr}`,
      }),
      () => process.execPath,
    ).invoke(request(context({})));

    expect(response.status).toBe('ok');
  });

  test('OpenAI rejects a Codex tool trace even when it precedes the first answer', async () => {
    const response = await openaiAdapter(
      new FakeCli(
        codexCli('gpt-5.6-sol', answer, [
          'exec',
          'powershell -Command Get-Location',
          'succeeded in 10ms:',
        ]),
      ),
      () => process.execPath,
    ).invoke(request(context({})));

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
    const response = await openaiAdapter(
      new FakeCli({
        ...codexCli('gpt-5.6-sol'),
        stderr: codexCli('gpt-5.6-sol').stderr.replace(stagedCouncilPrompt, windowsPrompt),
      }),
      () => process.execPath,
    ).invoke({
      ...request(context({})),
      prompt: windowsMotion,
    });

    expect(response.status).toBe('ok');
  });

  test('OpenAI accepts a pretty multiline answer with Windows output line endings', async () => {
    const prettyAnswer = JSON.stringify(JSON.parse(answer), null, 2);
    const response = await openaiAdapter(
      new FakeCli({
        ...codexCli('gpt-5.6-sol', prettyAnswer),
        stdout: prettyAnswer.replace(/\n/g, '\r\n'),
      }),
      () => process.execPath,
    ).invoke(request(context({})));

    expect(response.status).toBe('ok');
  });

  test('OpenAI rejects unrecognised text between the prompt and final answer', async () => {
    const response = await openaiAdapter(
      new FakeCli(codexCli('gpt-5.6-sol', answer, ['read_file: council-prompt.txt'])),
      () => process.execPath,
    ).invoke(request(context({})));

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
      const response = await openaiAdapter(
        new FakeCli(codexCli('gpt-5.6-sol', answer, activity)),
        () => process.execPath,
      ).invoke(request(context({})));

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
    const response = await googleAdapter(transport, () => process.execPath).invoke(
      request(context({})),
    );

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
    const response = await googleAdapter(
      new FakeCli(okCli(await capturedAgyOutput())),
      () => process.execPath,
    ).invoke(request(context({})));

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
    const adapter = googleAdapter(new FakeCli(okCli(withoutIdentity)), () => process.execPath);
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

  test('Google preserves approved fallback and observed model drift in health', async () => {
    const fallback = await googleAdapter(
      new FakeCli(okCli(agyOutput('gemini-3.6-flash-high'))),
      () => process.execPath,
    ).invoke(request(context({})));
    expect(fallback.status).toBe('ok');
    expect(fallback.actualModel).toBe('gemini-3.6-flash-high');
    expect(fallback.route).toBe('same-provider-fallback');

    const unexpected = await googleAdapter(
      new FakeCli(okCli(agyOutput('gemini-unapproved'))),
      () => process.execPath,
    ).invoke(request(context({})));
    expect(unexpected.status).toBe('failed');
    if (unexpected.status === 'ok') throw new Error('unapproved AGY run succeeded');
    expect(unexpected.error.code).toBe('identity-unverified');
    expect(unexpected.actualModel).toBe('gemini-unapproved');
    expect(unexpected.modelIdentity).toBe('unverified');

    const health = await googleAdapter(
      new FakeCli(okCli(agyOutput('gemini-unapproved'))),
      () => process.execPath,
    ).probe(context({}));
    expect(health.status).toBe('identity-unverified');
    expect(health.actualModel).toBe('gemini-unapproved');

    const report = await doctor(
      [googleAdapter(new FakeCli(okCli(agyOutput('gemini-unapproved'))), () => process.execPath)],
      context({}),
      '2026-07-29T00:00:00.000Z',
    );
    expect(report.diagnostics[0]?.actualModel).toBe('gemini-unapproved');
    expect(report.diagnostics[0]?.remediationCodes).toContain('review-route-drift');
  });

  test('Google retains verified fallback identity when the answer schema is invalid', async () => {
    const response = await googleAdapter(
      new FakeCli(okCli(agyOutput('gemini-3.6-flash-high', 'not-json'))),
      () => process.execPath,
    ).invoke(request(context({})));

    expect(response.status).toBe('failed');
    if (response.status === 'ok') throw new Error('invalid answer unexpectedly succeeded');
    expect(response.error.code).toBe('invalid-structured-answer');
    expect(response.actualModel).toBe('gemini-3.6-flash-high');
    expect(response.modelIdentity).toBe('verified');
    expect(response.route).toBe('same-provider-fallback');

    const report = await doctor(
      [
        googleAdapter(
          new FakeCli(okCli(agyOutput('gemini-3.6-flash-high', 'not-json'))),
          () => process.execPath,
        ),
      ],
      context({}),
      '2026-07-29T00:00:00.000Z',
    );
    expect(report.diagnostics[0]?.actualModel).toBe('gemini-3.6-flash-high');
    expect(report.diagnostics[0]?.remediationCodes).toContain('review-route-drift');
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
    const unknownStep = {
      event: 'step_update',
      step_update: { step_index: 7, state: 'DONE', step_type: 'network' },
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
        agyOutput('gemini-3.1-pro-high', answer, { additionalEvents: [unknownStep] }),
        'identity-unverified',
      ],
      [
        agyOutput('gemini-3.1-pro-high', answer, { additionalEvents: [disguisedTool] }),
        'unsafe-tool-isolation',
      ],
      [agyOutput('gemini-3.1-pro-high', answer, { duplicateResult: true }), 'identity-unverified'],
    ] as const;

    for (const [output, errorCode] of cases) {
      const response = await googleAdapter(
        new FakeCli(okCli(output)),
        () => process.execPath,
      ).invoke(request(context({})));
      expect(response.status).toBe('failed');
      if (response.status === 'ok') throw new Error('invalid AGY stream unexpectedly succeeded');
      expect(response.error.code).toBe(errorCode);
    }
  });

  test('Google tool-policy drift is reported as unsafe isolation', async () => {
    const unsafeOutput = agyOutput('gemini-3.1-pro-high', answer, {
      toolName: 'browser_get_dom',
    });
    const health = await googleAdapter(
      new FakeCli(okCli(unsafeOutput)),
      () => process.execPath,
    ).probe(context({}));
    expect(health.status).toBe('unsafe-transport');

    const report = await doctor(
      [googleAdapter(new FakeCli(okCli(unsafeOutput)), () => process.execPath)],
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
    const health = await openaiAdapter(new FakeCli(rejectedCli), () => process.execPath).probe(
      context({}),
    );
    expect(health.status).toBe('unsafe-transport');

    const report = await doctor(
      [openaiAdapter(new FakeCli(rejectedCli), () => process.execPath)],
      context({}),
      '2026-07-29T00:00:00.000Z',
    );
    expect(report.diagnostics[0]?.toolIsolation).toBe('unsupported');
    expect(report.diagnostics[0]?.remediationCodes).toContain('secure-transport');
  });

  test('missing subscription executables skip instead of falling back to API keys', async () => {
    const adapters = [
      openaiAdapter(new FakeCli(okCli('')), () => undefined),
      googleAdapter(new FakeCli(okCli('')), () => undefined),
    ];
    for (const adapter of adapters) {
      const response = await adapter.invoke(
        request(context({ OPENAI_API_KEY: 'unused', GEMINI_API_KEY: 'unused' })),
      );
      expect(response.status).toBe('skipped');
      if (response.status === 'ok') throw new Error('missing executable unexpectedly succeeded');
      expect(response.error.code).toBe('missing-executable');
    }
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
    const response = await anthropicAdapter(transport, () => process.execPath).invoke(
      request(context({})),
    );

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

    const response = await anthropicAdapter(transport, () => process.execPath).invoke(
      request(context({}, diagnostics)),
    );

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
    const response = await anthropicAdapter(transport, () => undefined).invoke(
      request(context({})),
    );
    expect(response.status).toBe('skipped');
    if (response.status === 'ok') throw new Error('missing executable unexpectedly succeeded');
    expect(response.error.code).toBe('missing-executable');
  });
});
