import { describe, expect, test } from 'bun:test';
import {
  ADVISOR_ANSWER,
  NEVER_METERED_SPEND,
  advisorPrompt,
  consultSeat,
  selectSeatFamily,
  subscriptionFamilies,
} from '../../src/modes/advisor/seat';
import { NOTE_TEXT_LIMIT } from '../../src/modes/advisor/notes';
import type {
  ModelTransport,
  ProviderFamily,
  SeatResponse,
} from '../../src/substrate/domain/schemas';
import {
  withCredentialFallback,
  type Availability,
  type HealthResult,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderRequest,
} from '../../src/substrate/execution/provider';
import type { ModelRegistry } from '../../src/substrate/models/registry';

const registry: ModelRegistry = {
  anthropic: { primary: 'anthropic-primary', fallbacks: [], transport: 'subscription-cli' },
  openai: { primary: 'openai-primary', fallbacks: [], transport: 'subscription-cli' },
  xai: {
    primary: 'xai-primary',
    fallbacks: [],
    transport: 'subscription-cli',
    alternateTransports: ['http'],
  },
  google: { primary: 'google-primary', fallbacks: [], transport: 'subscription-cli' },
  deepseek: { primary: 'deepseek-primary', fallbacks: [], transport: 'http' },
  moonshot: { primary: 'moonshot-primary', fallbacks: [], transport: 'http' },
};

function context(timeoutMs = 1_000): ProviderContext {
  return { registry, env: {}, cwd: 'C:/isolated/advisor', timeoutMs };
}

type FakeReply = (request: ProviderRequest) => SeatResponse | Promise<SeatResponse>;

class FakeAdapter implements ProviderAdapter {
  readonly calls: ProviderRequest[] = [];

  constructor(
    readonly family: ProviderFamily,
    private readonly reply: FakeReply,
    private readonly available: Availability['status'] = 'available',
    readonly transport: ModelTransport = registry[family].transport,
  ) {}

  async availability(): Promise<Availability> {
    return {
      status: this.available,
      provider: this.family,
      model: registry[this.family].primary,
      reason: this.available === 'available' ? '' : 'missing COUNCIL_TEST_KEY',
    };
  }

  async invoke(request: ProviderRequest): Promise<SeatResponse> {
    this.calls.push(request);
    return this.reply(request);
  }

  async probe(): Promise<HealthResult> {
    return {
      status: 'healthy',
      provider: this.family,
      requestedModel: registry[this.family].primary,
      actualModel: registry[this.family].primary,
      latencyMs: 1,
      reason: '',
    };
  }
}

function ok(request: ProviderRequest, family: ProviderFamily, answer: string): SeatResponse {
  return {
    status: 'ok',
    seatId: request.seatId,
    provider: family,
    requestedModel: registry[family].primary,
    actualModel: registry[family].primary,
    modelIdentity: 'verified',
    route: 'primary',
    role: request.role,
    latencyMs: 5,
    answer,
    credentialPath: 'subscription',
  };
}

function failed(request: ProviderRequest, family: ProviderFamily, code: string): SeatResponse {
  return {
    status: 'failed',
    seatId: request.seatId,
    provider: family,
    requestedModel: registry[family].primary,
    role: request.role,
    latencyMs: 1,
    error: { code, message: `${code} happened`, retryable: false },
  };
}

const answer = (severity: string, text: string) => JSON.stringify({ severity, text });

describe('advisor family selection', () => {
  test('a metered-only family is never offered a seat', () => {
    expect(subscriptionFamilies(['anthropic', 'deepseek', 'xai', 'moonshot'], registry)).toEqual([
      'anthropic',
      'xai',
    ]);
  });

  test('the first available family in the caller order wins; availability is local', async () => {
    const anthropic = new FakeAdapter('anthropic', (r) => ok(r, 'anthropic', '{}'), 'unconfigured');
    const openai = new FakeAdapter('openai', (r) => ok(r, 'openai', '{}'));
    const selection = await selectSeatFamily(
      ['deepseek', 'anthropic', 'openai', 'xai'],
      { anthropic, openai },
      context(),
    );
    expect(selection).toEqual({ family: 'openai', reason: null });
    expect(anthropic.calls).toHaveLength(0);
    expect(openai.calls).toHaveLength(0);
  });

  test('no available family is a reason, not an error', async () => {
    const anthropic = new FakeAdapter('anthropic', (r) => ok(r, 'anthropic', '{}'), 'unconfigured');
    const none = await selectSeatFamily(['anthropic', 'google'], { anthropic }, context());
    expect(none.family).toBeNull();
    expect(none.reason).toContain('anthropic: unconfigured');
    expect(none.reason).toContain('google: no adapter');
    const metered = await selectSeatFamily(['deepseek'], {}, context());
    expect(metered.reason).toContain('no subscription-capable family');
  });
});

describe('advisor prompt', () => {
  test('frames the trigger, names the class and window, and quotes the material as data', () => {
    const prompt = advisorPrompt({
      trigger: 'hold',
      material: 'git push --force origin main <x>',
      riskClass: 'destructive-git',
      budgetMs: 8_000,
    });
    expect(prompt).toContain('destructive-git');
    expect(prompt).toContain('8 seconds');
    expect(prompt).toContain('Evidence envelope rule');
    expect(prompt).toContain('<untrusted-tool-call>');
    expect(prompt).toContain('git push --force origin main &lt;x&gt;');
    expect(prompt).not.toContain('<x>');
    expect(advisorPrompt({ trigger: 'ask', material: 'q' })).toContain('<untrusted-question>');
    expect(advisorPrompt({ trigger: 'cadence', material: 'w' })).toContain(
      '<untrusted-transcript-window>',
    );
    expect(ADVISOR_ANSWER.instruction).toContain(String(NOTE_TEXT_LIMIT));
  });
});

describe('advisor consultation', () => {
  test('an ok answer becomes a note with its seat, truncated to the limit', async () => {
    const long = 'x'.repeat(NOTE_TEXT_LIMIT + 50);
    const anthropic = new FakeAdapter('anthropic', (r) =>
      ok(r, 'anthropic', answer('caution', long)),
    );
    const result = await consultSeat({
      family: 'anthropic',
      adapters: { anthropic },
      context: context(),
      prompt: 'p',
      budgetMs: 1_000,
    });
    expect(result.status).toBe('ok');
    expect(result.severity).toBe('caution');
    expect(result.text).toHaveLength(NOTE_TEXT_LIMIT);
    expect(result.seatId).toBe('anthropic/anthropic-primary#advisor');
    expect(result.seat).toMatchObject({
      id: result.seatId,
      status: 'ok',
      transport: 'subscription',
    });
    expect(result.spend).toMatchObject({ policy: 'never-metered', billing: 'sub-only', used: 0 });
    expect(anthropic.calls[0]?.answer?.instruction).toBe(ADVISOR_ANSWER.instruction);
    expect(anthropic.calls[0]?.context.timeoutMs).toBeLessThanOrEqual(1_000);
  });

  test('an astral-character answer over the limit is cut without a lone surrogate', async () => {
    // A leading plain character puts the emoji run at an odd UTF-16 offset, so a naive
    // `.slice(0, NOTE_TEXT_LIMIT)` would land inside a surrogate pair; `safeExcerpt` walks whole
    // characters instead. 300 emoji plus the prefix is 601 units, one past NOTE_TEXT_LIMIT (600),
    // so a cut is guaranteed.
    const long = `x${'\u{1F600}'.repeat(300)}`;
    const anthropic = new FakeAdapter('anthropic', (r) => ok(r, 'anthropic', answer('info', long)));
    const result = await consultSeat({
      family: 'anthropic',
      adapters: { anthropic },
      context: context(),
      prompt: 'p',
      budgetMs: 1_000,
    });
    expect(result.status).toBe('ok');
    expect(result.text.length).toBeLessThanOrEqual(NOTE_TEXT_LIMIT);
    if (typeof result.text.isWellFormed === 'function') {
      expect(result.text.isWellFormed()).toBe(true);
    } else {
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(result.text),
      ).toBe(false);
    }
  });

  test('an empty answer is silence, recorded as no-advice', async () => {
    const anthropic = new FakeAdapter('anthropic', (r) => ok(r, 'anthropic', answer('info', '  ')));
    const result = await consultSeat({
      family: 'anthropic',
      adapters: { anthropic },
      context: context(),
      prompt: 'p',
      budgetMs: 1_000,
    });
    expect(result).toMatchObject({ status: 'no-advice', reason: 'seat-silent', text: '' });
  });

  test('an off-shape answer is skipped with the panel reason', async () => {
    const anthropic = new FakeAdapter('anthropic', (r) => ok(r, 'anthropic', 'Just proceed.'));
    const result = await consultSeat({
      family: 'anthropic',
      adapters: { anthropic },
      context: context(),
      prompt: 'p',
      budgetMs: 1_000,
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('invalid-answer');
    expect(result.seat?.status).toBe('invalid');
  });

  test('never-metered: an exhausted subscription is skipped and the metered path is never called', async () => {
    const metered = new FakeAdapter(
      'xai',
      (r) => ({ ...ok(r, 'xai', answer('info', 'paid')), credentialPath: 'api-key' }),
      'available',
      'http',
    );
    const subscription = new FakeAdapter('xai', (r) => failed(r, 'xai', 'quota-exhausted'));
    const xai = withCredentialFallback(subscription, () => metered, 'http');
    const result = await consultSeat({
      family: 'xai',
      adapters: { xai },
      context: context(),
      prompt: 'p',
      budgetMs: 1_000,
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('quota-exhausted');
    expect(result.reason).toContain('never-metered');
    expect(metered.calls).toHaveLength(0);
    expect(result.spend).toEqual(NEVER_METERED_SPEND);
  });

  test('a seat that does not answer inside the window is no-advice, on time', async () => {
    const never = new FakeAdapter('anthropic', () => new Promise<SeatResponse>(() => undefined));
    const started = Date.now();
    const result = await consultSeat({
      family: 'anthropic',
      adapters: { anthropic: never },
      context: context(60_000),
      prompt: 'p',
      budgetMs: 100,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toMatchObject({
      status: 'no-advice',
      reason: 'window-elapsed',
      text: '',
      seat: null,
    });
    expect(never.calls[0]?.context.timeoutMs).toBeLessThanOrEqual(100);
  });

  test('a transport timeout inside the window is no-advice too', async () => {
    const slow = new FakeAdapter('anthropic', (r) => ({
      status: 'timed-out',
      seatId: r.seatId,
      provider: 'anthropic',
      requestedModel: registry.anthropic.primary,
      role: r.role,
      latencyMs: 90,
      error: { code: 'timeout', message: 'claude process timed out', retryable: false },
    }));
    const result = await consultSeat({
      family: 'anthropic',
      adapters: { anthropic: slow },
      context: context(),
      prompt: 'p',
      budgetMs: 1_000,
    });
    expect(result).toMatchObject({ status: 'no-advice', reason: 'timeout' });
  });
});
