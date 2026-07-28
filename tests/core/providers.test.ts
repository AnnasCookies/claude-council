import { beforeEach, describe, expect, test } from 'bun:test';
import { loadModelRegistry, type ModelRegistry } from '../../src/models/registry';
import type { CliRequest, CliResult } from '../../src/execution/cli';
import type { HttpRequest, HttpResult, RetryPolicy } from '../../src/execution/http';
import {
  type CliTransport,
  type HttpTransport,
  type ProviderContext,
  type ProviderDiagnostic,
  type ProviderRequest,
} from '../../src/execution/provider';
import { anthropicAdapter } from '../../src/providers/anthropic-cli';
import { deepseekAdapter } from '../../src/providers/deepseek';
import { googleAdapter } from '../../src/providers/google';
import { moonshotAdapter } from '../../src/providers/moonshot';
import { openaiAdapter } from '../../src/providers/openai';
import { xaiAdapter } from '../../src/providers/xai';
import { createProviderRoster } from '../../src/providers';

const answer = JSON.stringify({
  recommendation: 'Proceed carefully.',
  evidence: ['The invariant holds.'],
  assumptions: ['Inputs are validated.'],
  risks: ['Provider drift.'],
  uncertainty: 'Low.',
  decisiveTest: 'Run the isolated acceptance path.',
});

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
  });
});

describe('HTTP provider adapters', () => {
  test('OpenAI sends the exact primary selector without tools or local paths', async () => {
    const transport = new FakeHttp([
      {
        ...okHttp('gpt-5.6-sol'),
        body: {
          model: 'gpt-5.6-sol',
          output: [{ content: [{ type: 'output_text', text: answer }] }],
        },
      },
    ]);
    const response = await openaiAdapter(transport).invoke(
      request(context({ OPENAI_API_KEY: 'test-openai-key' })),
    );

    expect(response.status).toBe('ok');
    expect(response.actualModel).toBe('gpt-5.6-sol');
    const payload: unknown = JSON.parse(String(transport.calls[0]?.request.body));
    expect(payload).toMatchObject({ model: 'gpt-5.6-sol' });
    expect(JSON.stringify(payload)).not.toContain('tools');
    expect(JSON.stringify(payload)).not.toContain('functions');
    expect(JSON.stringify(payload)).not.toContain('C:/private/project-root');
  });

  test('redacts high-confidence secrets from structured provider answers', async () => {
    const secret = ['sk', 'proj', '1234567890abcdefghijklmnop'].join('-');
    const providerAnswer = JSON.stringify({
      ...JSON.parse(answer),
      recommendation: `Never retain ${secret}`,
    });
    const transport = new FakeHttp([
      {
        ...okHttp('gpt-5.6-sol'),
        body: {
          model: 'gpt-5.6-sol',
          output: [{ content: [{ type: 'output_text', text: providerAnswer }] }],
        },
      },
    ]);

    const response = await openaiAdapter(transport).invoke(
      request(context({ OPENAI_API_KEY: 'test-openai-key' })),
    );

    expect(response.status).toBe('ok');
    expect(response.status === 'ok' ? response.answer : '').not.toContain(secret);
    expect(response.status === 'ok' ? response.answer : '').toContain('<SECRET:OPENAI:');
  });

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

  test('Google falls back only from Pro Preview to Flash and reports it explicitly', async () => {
    const transport = new FakeHttp([
      modelMissing(),
      {
        ...okHttp('gemini-3.6-flash'),
        body: {
          modelVersion: 'gemini-3.6-flash',
          candidates: [{ content: { parts: [{ text: answer }] } }],
        },
      },
    ]);
    const response = await googleAdapter(transport).invoke(
      request(context({ GEMINI_API_KEY: 'test-google-key' })),
    );

    expect(response.provider).toBe('google');
    expect(response.requestedModel).toBe('gemini-3.1-pro-preview');
    expect(response.actualModel).toBe('gemini-3.6-flash');
    expect(response.route).toBe('same-provider-fallback');
    expect(transport.calls).toHaveLength(2);
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
    for (const adapter of [
      openaiAdapter,
      xaiAdapter,
      googleAdapter,
      deepseekAdapter,
      moonshotAdapter,
    ]) {
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
