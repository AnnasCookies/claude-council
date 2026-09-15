import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advisor } from '../../src/modes/advisor';
import type { HandlerInput } from '../../src/modes';
import {
  ModeSessionStore,
  ProviderFamilySchema,
  evaluateOutbound,
  type ModelRegistry,
  type ModelTransport,
  type PolicyDecision,
  type ProjectPolicy,
  type ProviderContext,
  type ProviderFamily,
  type ProviderRequest,
  type SeatResponse,
} from '../../src/substrate';
import {
  withCredentialFallback,
  type Availability,
  type HealthResult,
  type ProviderAdapter,
} from '../../src/substrate/execution/provider';

const NOW = '2026-09-15T10:00:00.000Z';
const KEY = 'claude:6a07f29b-a0a5-4f23-91ab-2b6b2dbee514';

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

const policy: ProjectPolicy = {
  projectId: 'general',
  classification: 'public',
  allowedProviders: [...ProviderFamilySchema.options],
  providerCeilings: Object.fromEntries(
    ProviderFamilySchema.options.map((provider) => [provider, 'public'] as const),
  ),
  createdAt: NOW,
  updatedAt: NOW,
};

function guard(payloads: readonly string[]): PolicyDecision {
  return evaluateOutbound({
    runId: 'advisor-test',
    classification: 'public',
    policy,
    destinations: [{ provider: 'anthropic', model: 'anthropic-primary' }],
    payloads: payloads.length === 0 ? [''] : [...payloads],
  });
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
      reason: '',
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

function ok(
  request: ProviderRequest,
  family: ProviderFamily,
  severity: string,
  text: string,
): SeatResponse {
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
    answer: JSON.stringify({ severity, text }),
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

const cautious = (family: ProviderFamily) =>
  new FakeAdapter(family, (request) =>
    ok(request, family, 'caution', `${family} says: mind the blast radius.`),
  );

interface Call {
  readonly flags: Record<string, string | true>;
  readonly positionals?: string[];
  readonly stdin?: string;
  readonly session?: string | null;
  readonly adapters?: Partial<Record<ProviderFamily, ProviderAdapter>>;
  readonly families?: ProviderFamily[];
  readonly timeoutMs?: number;
}

function input(root: string, call: Call): HandlerInput {
  const flags = new Map<string, string[]>();
  for (const [name, value] of Object.entries(call.flags))
    flags.set(name, [value === true ? 'true' : value]);
  const context: ProviderContext = {
    registry,
    env: {},
    cwd: root,
    timeoutMs: call.timeoutMs ?? 1_000,
  };
  const sessionKey = call.session === null ? undefined : (call.session ?? KEY);
  return {
    command: 'advise',
    options: {
      caller: { kind: 'agent', harness: 'test', declared: true },
      scope: 'general',
      classification: 'public',
      eligibleProviderFamilies: [...ProviderFamilySchema.options],
      providerFamilies: call.families ?? ['deepseek', 'anthropic', 'openai'],
      ...(sessionKey === undefined ? {} : { sessionKey }),
      timeoutMs: context.timeoutMs,
      billingMode: 'sub-only',
      recordsRoot: root,
    },
    flags,
    positionals: call.positionals ?? [],
    ...(call.stdin === undefined ? {} : { stdin: call.stdin }),
    adapters: call.adapters ?? { anthropic: cautious('anthropic'), openai: cautious('openai') },
    context,
    policyDecision: guard([]),
    guard,
    sessions: ModeSessionStore.open(root),
    spend: { policy: 'never-metered' },
    now: () => NOW,
  };
}

async function result(root: string, call: Call) {
  const outcome = await advisor.handle(input(root, call));
  if (outcome.kind !== 'result') throw new Error('unreachable');
  advisor.outputSchema.parse(outcome.output);
  return outcome;
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'council-advisor-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function logText(root: string, session: string): Promise<string> {
  return Bun.file(ModeSessionStore.open(root).absolutePath('advisor', session)).text();
}

describe('advisor mode', () => {
  test('declares the knobs and seams the CLI relies on', () => {
    expect(advisor).toMatchObject({
      kind: 'handler',
      name: 'advisor',
      pattern: 'streaming',
      session: 'key',
      acceptsPositionals: true,
    });
    expect(advisor.spend.policy).toBe('never-metered');
    expect(advisor.flags.boolean).toEqual(['watch', 'hold', 'note', 'start', 'end', 'status']);
  });

  test('--start binds the harness key to a minted log and is idempotent', async () => {
    await withRoot(async (root) => {
      const started = await result(root, { flags: { start: true } });
      expect(started.session).toMatch(/^ad-2026-09-15-[a-f0-9]{6}$/);
      expect(started.output).toEqual({ started: { session: started.session } });
      expect(started.record).toEqual({
        session: `general/modes/advisor/${started.session}.jsonl`,
        paths: [],
      });
      expect(started.rounds).toBe(0);
      const again = await result(root, { flags: { start: true } });
      expect(again.session).toBe(started.session);
      expect((await logText(root, started.session)).split('\n').filter(Boolean)).toHaveLength(1);
      const status = await result(root, { flags: { status: true } });
      expect(status.output).toEqual({ status: { exists: true, notes: 0, last: null } });
      const unbound = await result(root, { flags: { status: true }, session: 'claude:nobody' });
      expect(unbound.output).toEqual({ status: { exists: false, notes: 0, last: null } });
      expect(unbound.record.session).toBeNull();
    });
  });

  test('--hold consults the first available subscription family and records the excerpt only', async () => {
    await withRoot(async (root) => {
      const anthropic = cautious('anthropic');
      const openai = cautious('openai');
      const tool = `git push --force origin main ${'x'.repeat(400)}`;
      const outcome = await result(root, {
        flags: { hold: true, class: 'destructive-git', tool },
        adapters: { anthropic, openai },
      });
      const note = (outcome.output as { note: Record<string, unknown> }).note;
      expect(note).toMatchObject({
        id: 'n-1',
        trigger: 'hold',
        severity: 'caution',
        status: 'ok',
        reason: null,
        heeded: 'unknown',
        seat: 'anthropic/anthropic-primary#advisor',
        at: NOW,
      });
      expect(String(note.text)).toContain('anthropic says');
      expect((note.refersTo as { toolCall: string }).toolCall).toHaveLength(200);
      expect(anthropic.calls).toHaveLength(1);
      expect(openai.calls).toHaveLength(0);
      expect(anthropic.calls[0]?.context.timeoutMs).toBeGreaterThan(1_000);
      expect(anthropic.calls[0]?.context.timeoutMs).toBeLessThanOrEqual(8_000);
      expect(anthropic.calls[0]?.prompt).toContain('destructive-git');
      expect(outcome.seats).toHaveLength(1);
      expect(outcome.rounds).toBe(1);
      expect(outcome.degraded).toEqual([]);
      expect(outcome.record.paths).toEqual([]);
      expect(await logText(root, outcome.session)).not.toContain('x'.repeat(300));
    });
  });

  test('--hold refuses an unnamed class and never falls back to a metered key', async () => {
    await withRoot(async (root) => {
      await expect(
        result(root, { flags: { hold: true, class: 'network', tool: 'curl' } }),
      ).rejects.toThrow(/destructive-git, delete, deploy, payment, credential/);
      await expect(result(root, { flags: { hold: true, class: 'delete' } })).rejects.toThrow(
        /--tool/,
      );

      const metered = new FakeAdapter(
        'xai',
        (request) => ({ ...ok(request, 'xai', 'info', 'paid'), credentialPath: 'api-key' }),
        'available',
        'http',
      );
      const subscription = new FakeAdapter('xai', (request) =>
        failed(request, 'xai', 'quota-exhausted'),
      );
      const outcome = await result(root, {
        flags: { hold: true, class: 'delete', tool: 'rm -rf build' },
        adapters: { xai: withCredentialFallback(subscription, () => metered, 'http') },
        families: ['xai'],
      });
      const note = (outcome.output as { note: { status: string; reason: string } }).note;
      expect(note.status).toBe('skipped');
      expect(note.reason).toContain('never-metered');
      expect(metered.calls).toHaveLength(0);
      expect(outcome.degraded).toEqual([`note-skipped: ${note.reason}`]);
      expect(outcome.spend).toMatchObject({ policy: 'never-metered', used: 0, fallbacks: 0 });
    });
  });

  test('a hold that outruns its window is no-advice, on time', async () => {
    await withRoot(async (root) => {
      const never = new FakeAdapter('anthropic', () => new Promise<SeatResponse>(() => undefined));
      const started = Date.now();
      const outcome = await result(root, {
        flags: { hold: true, class: 'deploy', tool: 'wrangler deploy', 'window-ms': '100' },
        adapters: { anthropic: never },
        timeoutMs: 60_000,
      });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(outcome.output).toMatchObject({
        note: { status: 'no-advice', reason: 'window-elapsed', severity: 'info', text: '' },
      });
      expect(outcome.seats).toEqual([]);
    });
  });

  test('--watch counts turns in the log and consults only every Nth call; the window is never recorded', async () => {
    await withRoot(async (root) => {
      const anthropic = cautious('anthropic');
      const window = 'user: drop the table\nassistant: running it now WINDOW-SENTINEL';
      const first = await result(root, {
        flags: { watch: true, every: '2', transcript: '-' },
        stdin: window,
        adapters: { anthropic },
      });
      expect(first.output).toMatchObject({
        note: { id: 'n-1', trigger: 'cadence', status: 'skipped', reason: 'cadence', seat: null },
      });
      expect(anthropic.calls).toHaveLength(0);
      const second = await result(root, {
        flags: { watch: true, every: '2', transcript: '-' },
        stdin: window,
        adapters: { anthropic },
      });
      expect(second.output).toMatchObject({
        note: { id: 'n-2', trigger: 'cadence', status: 'ok' },
      });
      expect(anthropic.calls).toHaveLength(1);
      expect(anthropic.calls[0]?.prompt).toContain('WINDOW-SENTINEL');
      expect(anthropic.calls[0]?.context.timeoutMs).toBeLessThanOrEqual(1_000);
      expect(await logText(root, second.session)).not.toContain('WINDOW-SENTINEL');
      await expect(result(root, { flags: { watch: true, transcript: '-' } })).rejects.toThrow(
        /stdin/,
      );
      await expect(result(root, { flags: { watch: true } })).rejects.toThrow(/--transcript/);
      await expect(
        result(root, {
          flags: { watch: true, transcript: '-', 'cadence-family': 'deepseek' },
          stdin: 'w',
        }),
      ).rejects.toThrow(/never spends a metered key/);
    });
  });

  test('a window carrying a secret is blocked before any seat and never recorded', async () => {
    await withRoot(async (root) => {
      const anthropic = cautious('anthropic');
      const secret = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
      const outcome = await result(root, {
        flags: { watch: true, every: '1', transcript: '-' },
        stdin: `token=${secret}`,
        adapters: { anthropic },
      });
      expect(outcome.output).toMatchObject({
        note: { status: 'skipped', reason: 'policy: high-confidence-secret-detected' },
      });
      expect(anthropic.calls).toHaveLength(0);
      expect(await logText(root, outcome.session)).not.toContain(secret);
    });
  });

  test('--ask answers a question and --note posts an external note', async () => {
    await withRoot(async (root) => {
      const asked = await result(root, {
        flags: { ask: 'Is there a simpler route than a migration here?' },
      });
      expect(asked.output).toMatchObject({
        note: {
          trigger: 'ask',
          status: 'ok',
          refersTo: { question: 'Is there a simpler route than a migration here?' },
          seat: 'anthropic/anthropic-primary#advisor',
        },
      });
      const posted = await result(root, {
        flags: { note: true, from: 'omp' },
        positionals: ['The', 'native seat says: check the lockfile.'],
      });
      expect(posted.output).toMatchObject({
        note: {
          id: 'n-2',
          trigger: 'external',
          status: 'ok',
          seat: 'omp',
          text: 'The native seat says: check the lockfile.',
          refersTo: {},
        },
      });
      expect(posted.rounds).toBe(0);
      await expect(
        result(root, { flags: { note: true, from: 'OMP' }, positionals: ['x'] }),
      ).rejects.toThrow(/--from/);
      await expect(result(root, { flags: { note: true, from: 'omp' } })).rejects.toThrow(
        /note text/,
      );
    });
  });

  test('--heed folds onto the note and is reported by --status', async () => {
    await withRoot(async (root) => {
      await result(root, {
        flags: { hold: true, class: 'payment', tool: 'stripe refunds create' },
      });
      const heeded = await result(root, { flags: { heed: 'n-1' }, positionals: ['yes'] });
      expect(heeded.output).toEqual({ heeded: { id: 'n-1', value: 'yes' } });
      const status = await result(root, { flags: { status: true } });
      expect(status.output).toMatchObject({
        status: { exists: true, notes: 1, last: { id: 'n-1', heeded: 'yes' } },
      });
      await expect(result(root, { flags: { heed: 'n-9' }, positionals: ['yes'] })).rejects.toThrow(
        /Unknown advisor note/,
      );
      await expect(
        result(root, { flags: { heed: 'n-1' }, positionals: ['maybe'] }),
      ).rejects.toThrow(/yes, no or unknown/);
      await expect(
        result(root, { flags: { heed: 'n-1' }, positionals: ['yes'], session: 'claude:nobody' }),
      ).rejects.toThrow(/Unknown advisor session/);
    });
  });

  test('--end hands the log to the commit path once and closes the session', async () => {
    await withRoot(async (root) => {
      const hold = await result(root, {
        flags: { hold: true, class: 'credential', tool: 'bw get password prod' },
      });
      const ended = await result(root, { flags: { end: true } });
      expect(ended.output).toEqual({ ended: { notes: 1, committed: true } });
      expect(ended.record).toEqual({
        session: `general/modes/advisor/${hold.session}.jsonl`,
        paths: [ModeSessionStore.open(root).absolutePath('advisor', hold.session)],
      });
      expect(ended.seats.map((seat) => seat.id)).toEqual(['anthropic/anthropic-primary#advisor']);
      const again = await result(root, { flags: { end: true } });
      expect(again.output).toEqual({ ended: { notes: 1, committed: false } });
      expect(again.record.paths).toEqual([]);
      await expect(result(root, { flags: { ask: 'still there?' } })).rejects.toThrow(/has ended/);
      const status = await result(root, { flags: { status: true } });
      expect(status.output).toMatchObject({ status: { exists: true, notes: 1 } });
      await expect(
        result(root, { flags: { end: true }, session: 'claude:nobody' }),
      ).rejects.toThrow(/Unknown advisor session/);
    });
  });

  test('a store session id is accepted as the key directly', async () => {
    await withRoot(async (root) => {
      const started = await result(root, { flags: { start: true }, session: null });
      const asked = await result(root, { flags: { ask: 'q' }, session: started.session });
      expect(asked.session).toBe(started.session);
      expect(await Bun.file(ModeSessionStore.open(root).aliasPath('advisor')).exists()).toBe(false);
    });
  });

  test('usage errors: no verb, two verbs, no session, no records root', async () => {
    await withRoot(async (root) => {
      await expect(result(root, { flags: {} })).rejects.toThrow(/exactly one of/);
      await expect(result(root, { flags: { hold: true, ask: 'q' } })).rejects.toThrow(
        /exactly one of/,
      );
      await expect(result(root, { flags: { ask: 'q' }, session: null })).rejects.toThrow(
        /--session/,
      );
      await expect(
        advisor.handle({ ...input(root, { flags: { ask: 'q' } }), sessions: null }),
      ).rejects.toThrow(/--records-root/);
    });
  });

  test('no available subscription family is a skipped note with the reasons', async () => {
    await withRoot(async (root) => {
      const outcome = await result(root, {
        flags: { ask: 'q' },
        adapters: {
          anthropic: new FakeAdapter(
            'anthropic',
            (r) => ok(r, 'anthropic', 'info', ''),
            'unconfigured',
          ),
        },
        families: ['deepseek', 'anthropic'],
      });
      expect(outcome.output).toMatchObject({ note: { status: 'skipped', seat: null } });
      expect((outcome.output as { note: { reason: string } }).note.reason).toContain(
        'anthropic: unconfigured',
      );
    });
  });

  test('an empty answer is silence, not advice', async () => {
    await withRoot(async (root) => {
      const outcome = await result(root, {
        flags: { ask: 'q' },
        adapters: {
          anthropic: new FakeAdapter('anthropic', (r) => ok(r, 'anthropic', 'info', '')),
        },
      });
      expect(outcome.output).toMatchObject({
        note: { status: 'no-advice', reason: 'seat-silent', text: '' },
      });
      expect(outcome.degraded).toEqual(['note-no-advice: seat-silent']);
    });
  });
});
