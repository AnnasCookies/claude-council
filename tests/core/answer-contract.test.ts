import { describe, expect, test } from 'bun:test';
import type { CliRequest, CliResult } from '../../src/substrate/execution/cli';
import type { HttpRequest, HttpResult, RetryPolicy } from '../../src/substrate/execution/http';
import {
  COUNCIL_ANSWER_CONTRACT,
  permitsCredentialFallback,
  type AnswerContract,
  type CliTransport,
  type HttpTransport,
  type ProviderContext,
  type ProviderRequest,
} from '../../src/substrate/execution/provider';
import { loadModelRegistry } from '../../src/substrate/models/registry';
import { anthropicAdapter } from '../../src/substrate/providers/anthropic-cli';
import { deepseekAdapter } from '../../src/substrate/providers/deepseek';
import { googleAdapter } from '../../src/substrate/providers/google';

const registry = await loadModelRegistry();

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

const voteContract: AnswerContract = {
  instruction:
    'Return exactly one JSON object with these keys: vote ("yes" or "no"), note (string). Do not wrap it in prose.',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['vote', 'note'],
    properties: {
      vote: { type: 'string', enum: ['yes', 'no'] },
      note: { type: 'string', minLength: 1 },
    },
  },
};

function context(env: Record<string, string | undefined>): ProviderContext {
  return { registry, env, cwd: 'C:/private/project-root', timeoutMs: 1_000 };
}

function request(providerContext: ProviderContext, answer?: AnswerContract): ProviderRequest {
  return {
    context: providerContext,
    seatId: 'seat-1',
    role: 'critic',
    prompt: 'Evaluate the supplied evidence pack.',
    ...(answer === undefined ? {} : { answer }),
  };
}

function chatCompletion(model: string, content: string): HttpResult {
  return {
    status: 'ok',
    attempts: 1,
    statusCode: 200,
    body: { model, choices: [{ message: { content } }] },
    errorCode: null,
    message: '',
  };
}

function firstMessageContent(http: FakeHttp): string {
  const body = JSON.parse(String(http.calls[0]?.request.body)) as {
    messages: { content: string }[];
  };
  return body.messages[0]?.content ?? '';
}

describe('answer contracts', () => {
  test('a bare request still sends the council instruction and enforces the council shape', async () => {
    const http = new FakeHttp([
      chatCompletion(registry.deepseek.primary, '{"vote":"yes","note":"n"}'),
    ]);
    const response = await deepseekAdapter(http).invoke(
      request(context({ COUNCIL_DEEPSEEK_API_KEY: 'test-key' })),
    );
    expect(response.status).toBe('failed');
    if (response.status !== 'failed') throw new Error('unreachable');
    expect(response.error.code).toBe('invalid-structured-answer');
    expect(firstMessageContent(http).startsWith(COUNCIL_ANSWER_CONTRACT.instruction)).toBe(true);
    expect(COUNCIL_ANSWER_CONTRACT.instruction).toContain('recommendation (string)');
    expect(Object.keys(COUNCIL_ANSWER_CONTRACT.jsonSchema)).toContain('properties');
  });

  test('a caller contract replaces the instruction and returns the reply text unjudged', async () => {
    const http = new FakeHttp([
      chatCompletion(registry.deepseek.primary, '```json\n{"vote":"yes","note":"n"}\n```'),
    ]);
    const response = await deepseekAdapter(http).invoke(
      request(context({ COUNCIL_DEEPSEEK_API_KEY: 'test-key' }), voteContract),
    );
    expect(response.status).toBe('ok');
    if (response.status !== 'ok') throw new Error('unreachable');
    expect(response.answer).toBe('{"vote":"yes","note":"n"}');
    expect(response.modelIdentity).toBe('verified');
    const content = firstMessageContent(http);
    expect(content.startsWith(voteContract.instruction)).toBe(true);
    expect(content).not.toContain(COUNCIL_ANSWER_CONTRACT.instruction);
    expect(content).toContain('Evaluate the supplied evidence pack.');
  });

  test('a caller contract does not turn prose into a failure, only emptiness', async () => {
    const prose = new FakeHttp([chatCompletion(registry.deepseek.primary, 'I would vote yes.')]);
    const proseResponse = await deepseekAdapter(prose).invoke(
      request(context({ COUNCIL_DEEPSEEK_API_KEY: 'test-key' }), voteContract),
    );
    expect(proseResponse.status).toBe('ok');
    if (proseResponse.status !== 'ok') throw new Error('unreachable');
    expect(proseResponse.answer).toBe('I would vote yes.');

    const empty = new FakeHttp([chatCompletion(registry.deepseek.primary, '   \n')]);
    const emptyResponse = await deepseekAdapter(empty).invoke(
      request(context({ COUNCIL_DEEPSEEK_API_KEY: 'test-key' }), voteContract),
    );
    expect(emptyResponse.status).toBe('failed');
    if (emptyResponse.status !== 'failed') throw new Error('unreachable');
    expect(emptyResponse.error.code).toBe('invalid-structured-answer');
  });

  test('a caller contract reaches the transports that constrain decoding', async () => {
    const http = new FakeHttp([
      {
        status: 'ok',
        attempts: 1,
        statusCode: 200,
        body: {
          modelVersion: registry.google.primary,
          candidates: [{ content: { parts: [{ text: '{"vote":"no","note":"x"}' }] } }],
        },
        errorCode: null,
        message: '',
      },
    ]);
    const gemini = await googleAdapter({
      env: { COUNCIL_GEMINI_API_KEY: 'test-key' },
      httpTransport: http,
      resolveExecutable: () => undefined,
      billingMode: 'api-only',
    }).invoke(request(context({ COUNCIL_GEMINI_API_KEY: 'test-key' }), voteContract));
    expect(gemini.status).toBe('ok');
    if (gemini.status !== 'ok') throw new Error('unreachable');
    expect(gemini.answer).toBe('{"vote":"no","note":"x"}');
    const body = JSON.parse(String(http.calls[0]?.request.body)) as {
      generationConfig: { responseJsonSchema: unknown };
      contents: { parts: { text: string }[] }[];
    };
    expect(body.generationConfig.responseJsonSchema).toEqual(voteContract.jsonSchema);
    expect(body.contents[0]?.parts[0]?.text.startsWith(voteContract.instruction)).toBe(true);

    const cli = new FakeCli({
      status: 'ok',
      executable: process.execPath,
      exitCode: 0,
      stdout: JSON.stringify({
        result: '{"vote":"no","note":"x"}',
        modelUsage: { [registry.anthropic.primary]: {} },
      }),
      stderr: '',
      durationMs: 10,
      treeTerminated: false,
      errorCode: null,
    });
    const claude = await anthropicAdapter({
      env: {},
      cliTransport: cli,
      resolveExecutable: () => process.execPath,
    }).invoke(request(context({}), voteContract));
    expect(claude.status).toBe('ok');
    if (claude.status !== 'ok') throw new Error('unreachable');
    expect(claude.answer).toBe('{"vote":"no","note":"x"}');
    const args = cli.calls[0]?.args ?? [];
    const schemaIndex = args.indexOf('--json-schema');
    expect(schemaIndex).toBeGreaterThanOrEqual(0);
    expect(args[schemaIndex + 1]).toBe(JSON.stringify(voteContract.jsonSchema));
    expect(cli.calls[0]?.stdin.startsWith(voteContract.instruction)).toBe(true);
  });

  test("the claude length guard is the council shape's alone; the prose guard is everyone's", async () => {
    // The length half caps every array at eight entries and names `recommendation`. Applied to a
    // caller contract it would silently truncate a mode that asks for twenty ideas; the plain-prose
    // half is a transport fix for the claude CLI's own JSON parse and every caller needs it.
    const claudeCli = (answer: string): FakeCli =>
      new FakeCli({
        status: 'ok',
        executable: process.execPath,
        exitCode: 0,
        stdout: JSON.stringify({
          result: answer,
          modelUsage: { [registry.anthropic.primary]: {} },
        }),
        stderr: '',
        durationMs: 10,
        treeTerminated: false,
        errorCode: null,
      });
    const adapter = (cli: FakeCli) =>
      anthropicAdapter({ env: {}, cliTransport: cli, resolveExecutable: () => process.execPath });

    const callerCli = claudeCli('{"vote":"no","note":"x"}');
    await adapter(callerCli).invoke(request(context({}), voteContract));
    const callerPrompt = callerCli.calls[0]?.stdin ?? '';
    expect(callerPrompt).not.toContain('at most eight entries');
    expect(callerPrompt).not.toContain('recommendation under 2500 characters');
    expect(callerPrompt).toContain('no line breaks or tab characters inside any string');

    const councilCli = claudeCli(
      JSON.stringify({
        recommendation: 'Ship it.',
        evidence: ['e'],
        assumptions: ['a'],
        risks: ['r'],
        uncertainty: 'low',
        decisiveTest: 'run it',
      }),
    );
    await adapter(councilCli).invoke(request(context({})));
    const councilPrompt = councilCli.calls[0]?.stdin ?? '';
    expect(councilPrompt).toContain('at most eight entries');
    expect(councilPrompt).toContain('no line breaks or tab characters inside any string');
  });

  test('the council contract is frozen all the way down', () => {
    expect(Object.isFrozen(COUNCIL_ANSWER_CONTRACT)).toBe(true);
    expect(Object.isFrozen(COUNCIL_ANSWER_CONTRACT.jsonSchema)).toBe(true);
    expect(Object.isFrozen(COUNCIL_ANSWER_CONTRACT.jsonSchema.properties)).toBe(true);
    expect(() => Object.assign(COUNCIL_ANSWER_CONTRACT.jsonSchema, { type: 'array' })).toThrow();
    expect(COUNCIL_ANSWER_CONTRACT.jsonSchema.type).toBe('object');
  });

  test('permitsCredentialFallback names only the failures another credential could fix', () => {
    const failure = (code: string) =>
      ({
        status: 'failed',
        seatId: 'seat-1',
        provider: 'xai',
        role: 'critic',
        error: { code, message: code, retryable: false },
      }) as const;
    expect(permitsCredentialFallback(failure('quota-exhausted'))).toBe(true);
    expect(permitsCredentialFallback(failure('missing-executable'))).toBe(true);
    expect(permitsCredentialFallback(failure('identity-unverified'))).toBe(false);
    expect(permitsCredentialFallback(failure('invalid-structured-answer'))).toBe(false);
  });
});
