import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODE_NAMES, isHandlerMode, modes, type HandlerInput } from '../../src/modes';
import { AudienceOutputSchema, audience } from '../../src/modes/audience';
import { AUDIENCE_ANSWER, MAX_QUOTE_LENGTH } from '../../src/modes/audience/reaction';
import {
  ModeSessionStore,
  ProviderFamilySchema,
  createSpendLedger,
  evaluateOutbound,
  loadModelRegistry,
  runPanel,
  spreadSeats,
  withCredentialFallback,
  type Availability,
  type HealthResult,
  type ModeSessionEvent,
  type PanelLens,
  type PolicyDecision,
  type ProviderAdapter,
  type ProviderFamily,
  type ProviderRequest,
  type SeatResponse,
} from '../../src/substrate';

const NOW = '2026-09-15T10:00:00.000Z';
const registry = await loadModelRegistry();
const PERSONAS = 'ops-manager,new-starter,sceptic';
const DEFAULT_FAMILIES: readonly ProviderFamily[] = ['anthropic', 'openai', 'xai'];

/** Deterministic and persona-specific, so a quote can be traced back to the reader who said it. */
function reply(persona: string): {
  clear: boolean;
  wouldAct: boolean;
  stoppedAt: string;
  quote: string;
} {
  return {
    clear: persona !== 'sceptic',
    wouldAct: persona === 'ops-manager',
    stoppedAt: persona === 'sceptic' ? 'paragraph 3' : 'the end',
    quote: `The ${persona} says the rota line is the only part that matters.`,
  };
}

type Behaviour = 'ok' | 'prose' | 'quota-exhausted' | 'long-quote';

function adapter(
  family: ProviderFamily,
  behaviour: Behaviour,
  calls: ProviderRequest[],
  // 'subscription' for every ordinary seat; the one adapter standing in for a metered fallback in
  // the never-metered test passes 'api-key', so `seatTransport` reports it as `api` rather than
  // `subscription` and the assertion on the served (capped) seat below can tell the two apart.
  credentialPath: 'subscription' | 'api-key' = 'subscription',
): ProviderAdapter {
  return {
    family,
    transport: registry[family].transport,
    async availability(): Promise<Availability> {
      return { status: 'available', provider: family, model: registry[family].primary, reason: '' };
    },
    async invoke(request: ProviderRequest): Promise<SeatResponse> {
      calls.push(request);
      if (behaviour === 'quota-exhausted') {
        return {
          status: 'failed',
          seatId: request.seatId,
          provider: family,
          requestedModel: registry[family].primary,
          role: request.role,
          latencyMs: 1,
          error: {
            code: 'quota-exhausted',
            message: 'Deterministic subscription exhaustion.',
            retryable: false,
          },
        };
      }
      const answer =
        behaviour === 'prose'
          ? 'I liked it, mostly.'
          : JSON.stringify(
              behaviour === 'long-quote'
                ? { ...reply(request.role), quote: 'a'.repeat(MAX_QUOTE_LENGTH + 120) }
                : reply(request.role),
            );
      return {
        status: 'ok',
        seatId: request.seatId,
        provider: family,
        requestedModel: registry[family].primary,
        actualModel: registry[family].primary,
        modelIdentity: 'verified',
        route: 'primary',
        role: request.role,
        latencyMs: 1,
        credentialPath,
        answer,
      };
    },
    async probe(): Promise<HealthResult> {
      return {
        status: 'healthy',
        provider: family,
        requestedModel: registry[family].primary,
        actualModel: registry[family].primary,
        latencyMs: 1,
        reason: '',
      };
    },
  } satisfies ProviderAdapter;
}

// The CLI's own guard always carries a project policy — a default, all-providers-at-public one
// for general scope — so an ordinary draft is not blocked for want of one. Built once here rather
// than per call, exactly as `generalPolicy` builds it in src/cli.ts.
const GENERAL_POLICY = {
  projectId: 'general',
  classification: 'public' as const,
  allowedProviders: [...ProviderFamilySchema.options],
  providerCeilings: Object.fromEntries(
    ProviderFamilySchema.options.map((family) => [family, 'public' as const]),
  ),
  createdAt: NOW,
  updatedAt: NOW,
};

function guard(payloads: readonly string[]): PolicyDecision {
  return evaluateOutbound({
    runId: 'audience-fixture',
    classification: 'public',
    policy: GENERAL_POLICY,
    destinations: [{ provider: 'anthropic', model: registry.anthropic.primary }],
    payloads: payloads.length === 0 ? [''] : [...payloads],
  });
}

interface Fixture {
  readonly cwd: string;
  readonly flags: Record<string, string>;
  readonly adapters: Partial<Record<ProviderFamily, ProviderAdapter>>;
  readonly families?: readonly ProviderFamily[];
  readonly sessions?: ModeSessionStore;
  readonly sessionId?: string;
  readonly motion?: string;
}

function input(fixture: Fixture): HandlerInput {
  return {
    command: 'audience',
    options: {
      caller: { kind: 'human', harness: 'test', declared: true },
      scope: 'general',
      classification: 'public',
      eligibleProviderFamilies: ProviderFamilySchema.options,
      providerFamilies: [...(fixture.families ?? DEFAULT_FAMILIES)],
      ...(fixture.motion === undefined ? {} : { motion: fixture.motion }),
      ...(fixture.sessionId === undefined ? {} : { sessionId: fixture.sessionId }),
      timeoutMs: 5_000,
      billingMode: 'sub-only',
    },
    flags: new Map(Object.entries(fixture.flags).map(([name, value]) => [name, [value]])),
    positionals: [],
    adapters: fixture.adapters,
    context: { registry, env: {}, cwd: fixture.cwd, timeoutMs: 5_000 },
    policyDecision: guard(['']),
    guard,
    sessions: fixture.sessions ?? null,
    spend: { policy: 'never-metered' },
    now: () => NOW,
  };
}

function numericPaths(value: unknown, path: readonly string[] = []): string[] {
  if (typeof value === 'number') return [path.join('.')];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => numericPaths(entry, [...path, String(index)]));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => numericPaths(entry, [...path, key]));
  }
  return [];
}

const DRAFT = '# Announcement\n\nThe rota changes on Monday. Confirm your shifts by Friday.\n';

async function withDraft(
  run: (directory: string) => Promise<void>,
  text: string = DRAFT,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'convene-audience-'));
  try {
    await writeFile(join(directory, 'announcement.md'), text);
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function seatId(family: ProviderFamily, persona: string): string {
  return `${family}/${registry[family].primary}#${persona}`;
}

describe('the audience mode', () => {
  test('is registered as a never-metered handler mode with its own flags', () => {
    expect([...MODE_NAMES]).toContain('audience');
    expect(isHandlerMode(modes.audience)).toBe(true);
    expect(modes.audience).toBe(audience);
    expect(audience.pattern).toBe('parallel');
    expect(audience.spend.policy).toBe('never-metered');
    expect(audience.spend.defaultCap(24, 1)).toBe(0);
    expect(audience.flags).toEqual({
      value: ['draft', 'personas', 'personas-file', 'question'],
      boolean: [],
    });
  });

  test('seats one voice per persona, in the order supplied, spread over the families', async () => {
    await withDraft(async (directory) => {
      const calls: ProviderRequest[] = [];
      const outcome = await audience.handle(
        input({
          cwd: directory,
          flags: { personas: PERSONAS, draft: 'announcement.md' },
          adapters: {
            anthropic: adapter('anthropic', 'ok', calls),
            openai: adapter('openai', 'ok', calls),
            xai: adapter('xai', 'ok', calls),
          },
        }),
      );
      expect(outcome.kind).toBe('result');
      if (outcome.kind !== 'result') throw new Error('unreachable');
      // No records root is configured in this fixture, so every voice answering still leaves the
      // run degraded: it could not keep a record of what they said.
      expect(outcome.status).toBe('degraded');
      expect(outcome.pattern).toBe('parallel');
      expect(outcome.rounds).toBe(1);
      expect(outcome.session).toMatch(/^au-2026-09-15-[a-f0-9]{6}$/);
      expect(outcome.seats.map((seat) => seat.id)).toEqual([
        seatId('anthropic', 'ops-manager'),
        seatId('openai', 'new-starter'),
        seatId('xai', 'sceptic'),
      ]);
      expect(outcome.seats.map((seat) => seat.lens)).toEqual([
        'ops-manager',
        'new-starter',
        'sceptic',
      ]);
      expect(outcome.seats.every((seat) => seat.status === 'ok')).toBe(true);
      const output = AudienceOutputSchema.parse(outcome.output);
      expect(output.personas).toEqual(['ops-manager', 'new-starter', 'sceptic']);
      expect(output.draft.path).toBe('announcement.md');
      expect(output.draft.sha256).toMatch(/^[a-f0-9]{64}$/);
      // Blind: every prompt carries the draft and its own persona, and no other seat's material.
      expect(calls).toHaveLength(3);
      expect(calls[0]?.prompt).toContain('ops-manager');
      expect(calls[0]?.prompt).not.toContain('sceptic');
      expect(calls[0]?.answer).toEqual({
        instruction: AUDIENCE_ANSWER.instruction,
        jsonSchema: AUDIENCE_ANSWER.jsonSchema,
      });
    });
  });

  test('the personas are the ones supplied even when a voice does not answer', async () => {
    await withDraft(async (directory) => {
      const calls: ProviderRequest[] = [];
      const outcome = await audience.handle(
        input({
          cwd: directory,
          flags: { personas: PERSONAS, draft: 'announcement.md' },
          adapters: {
            anthropic: adapter('anthropic', 'ok', calls),
            openai: adapter('openai', 'prose', calls),
            xai: adapter('xai', 'quota-exhausted', calls),
          },
        }),
      );
      if (outcome.kind !== 'result') throw new Error('unreachable');
      const output = AudienceOutputSchema.parse(outcome.output);
      expect(output.personas).toEqual(['ops-manager', 'new-starter', 'sceptic']);
      expect(output.reactions.map((reaction) => reaction.persona)).toEqual(['ops-manager']);
      expect(output.tallies.answered).toBe(1);
      expect(output.tallies.answered).toBeLessThan(output.personas.length);
      expect(outcome.status).toBe('degraded');
      expect(outcome.degraded).toContain('missing-voices');
      expect(outcome.seats.map((seat) => seat.status)).toEqual(['ok', 'invalid', 'skipped']);
      expect(outcome.seats[2]?.reason).toContain('never-metered');
    });
  });

  test('quotes are verbatim and attributed, and the tallies are counts of the fields', async () => {
    await withDraft(async (directory) => {
      const calls: ProviderRequest[] = [];
      const outcome = await audience.handle(
        input({
          cwd: directory,
          flags: { personas: PERSONAS, draft: 'announcement.md' },
          adapters: {
            anthropic: adapter('anthropic', 'ok', calls),
            openai: adapter('openai', 'ok', calls),
            xai: adapter('xai', 'ok', calls),
          },
        }),
      );
      if (outcome.kind !== 'result') throw new Error('unreachable');
      const output = AudienceOutputSchema.parse(outcome.output);
      expect(output.reactions).toEqual([
        {
          persona: 'ops-manager',
          seat: seatId('anthropic', 'ops-manager'),
          fields: { clear: true, wouldAct: true, stoppedAt: 'the end' },
          quote: reply('ops-manager').quote,
        },
        {
          persona: 'new-starter',
          seat: seatId('openai', 'new-starter'),
          fields: { clear: true, wouldAct: false, stoppedAt: 'the end' },
          quote: reply('new-starter').quote,
        },
        {
          persona: 'sceptic',
          seat: seatId('xai', 'sceptic'),
          fields: { clear: false, wouldAct: false, stoppedAt: 'paragraph 3' },
          quote: reply('sceptic').quote,
        },
      ]);
      expect(output.tallies).toEqual({
        answered: 3,
        clear: { yes: 2, no: 1 },
        wouldAct: { yes: 1, no: 2 },
      });
      // The only numbers this mode produces are the five counts.
      expect(numericPaths(output).sort()).toEqual([
        'tallies.answered',
        'tallies.clear.no',
        'tallies.clear.yes',
        'tallies.wouldAct.no',
        'tallies.wouldAct.yes',
      ]);
      expect(outcome.synthesis).toBeNull();
      expect(outcome.dissent).toBeNull();
      expect(outcome.unanimous).toBe(false);
    });
  });

  test('a long quote is cut to four hundred characters rather than losing the voice', async () => {
    await withDraft(async (directory) => {
      const calls: ProviderRequest[] = [];
      const outcome = await audience.handle(
        input({
          cwd: directory,
          flags: { personas: 'ops-manager', draft: 'announcement.md' },
          families: ['anthropic'],
          adapters: { anthropic: adapter('anthropic', 'long-quote', calls) },
        }),
      );
      if (outcome.kind !== 'result') throw new Error('unreachable');
      const output = AudienceOutputSchema.parse(outcome.output);
      expect(output.reactions[0]?.quote).toHaveLength(MAX_QUOTE_LENGTH);
      expect(output.reactions[0]?.quote.endsWith('…')).toBe(true);
      expect(output.tallies.answered).toBe(1);
    });
  });

  test('never-metered: a spent subscription is a skipped voice and no metered call is made', async () => {
    await withDraft(async (directory) => {
      const subscriptionCalls: ProviderRequest[] = [];
      const meteredCalls: ProviderRequest[] = [];
      const metered = adapter('xai', 'ok', meteredCalls, 'api-key');
      const subscription = adapter('xai', 'quota-exhausted', subscriptionCalls);
      const xai = withCredentialFallback(subscription, () => metered, 'http');
      const outcome = await audience.handle(
        input({
          cwd: directory,
          flags: { personas: 'sceptic', draft: 'announcement.md' },
          families: ['xai'],
          adapters: { xai },
        }),
      );
      if (outcome.kind !== 'result') throw new Error('unreachable');
      expect(meteredCalls).toHaveLength(0);
      expect(outcome.seats[0]).toMatchObject({
        status: 'skipped',
        transport: null,
        fallback: false,
      });
      expect(outcome.seats[0]?.reason).toContain('never-metered');
      expect(outcome.spend).toEqual({
        billing: 'sub-only',
        policy: 'never-metered',
        cap: 0,
        used: 0,
        fallbacks: 0,
        refused: 0,
        stoppedAtCap: false,
      });
      expect(outcome.status).toBe('degraded');

      // The same adapter stack under a cap: the metered path would have answered, so the skipped
      // seat above is the spend policy at work rather than a broken provider.
      const lenses: PanelLens[] = [{ name: 'sceptic', description: 'Assumes the worst.' }];
      const served = await runPanel(
        { adapters: { xai }, context: { registry, env: {}, cwd: directory, timeoutMs: 5_000 } },
        {
          seats: spreadSeats(['xai'], lenses, registry),
          prompt: () => 'React to the draft.',
          answer: AUDIENCE_ANSWER,
          spend: { policy: 'capped', billing: 'sub-first', ledger: createSpendLedger(1) },
        },
      );
      expect(meteredCalls).toHaveLength(1);
      expect(served.seats[0]).toMatchObject({ status: 'ok', transport: 'api', fallback: true });
    });
  });

  test('a high-confidence secret in the draft blocks the run before any seat is invoked', async () => {
    const secret = [
      ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
      'cHJpdmF0ZS1rZXktbWF0ZXJpYWw=',
      ['-----END', 'PRIVATE KEY-----'].join(' '),
    ].join('\n');
    await withDraft(async (directory) => {
      const calls: ProviderRequest[] = [];
      const outcome = await audience.handle(
        input({
          cwd: directory,
          flags: { personas: PERSONAS, draft: 'announcement.md' },
          adapters: {
            anthropic: adapter('anthropic', 'ok', calls),
            openai: adapter('openai', 'ok', calls),
            xai: adapter('xai', 'ok', calls),
          },
        }),
      );
      expect(outcome.kind).toBe('blocked');
      if (outcome.kind !== 'blocked') throw new Error('unreachable');
      expect(outcome.status).toBe('blocked-policy');
      expect(outcome.message).toContain('announcement.md');
      expect(outcome.decision?.reasonCodes).toContain('high-confidence-secret-detected');
      expect(outcome.message).not.toContain('cHJpdmF0ZS1rZXktbWF0ZXJpYWw=');
      expect(calls).toHaveLength(0);
    }, `# Deploy notes\n\nkey = "${secret}"\n`);
  });

  test('a metered-only family is not seated, and a metered-only selection is refused', async () => {
    await withDraft(async (directory) => {
      const calls: ProviderRequest[] = [];
      const outcome = await audience.handle(
        input({
          cwd: directory,
          flags: { personas: 'ops-manager,new-starter', draft: 'announcement.md' },
          families: ['anthropic', 'deepseek'],
          adapters: {
            anthropic: adapter('anthropic', 'ok', calls),
            deepseek: adapter('deepseek', 'ok', calls),
          },
        }),
      );
      if (outcome.kind !== 'result') throw new Error('unreachable');
      expect(outcome.seats.map((seat) => seat.family)).toEqual(['anthropic', 'anthropic']);
      expect(outcome.degraded).toContain('metered-only-families-unseated: deepseek');
      // A family this build declined to seat is a degraded run even though every seated voice
      // answered: `degraded` says why, and a completed status would bury it.
      expect(outcome.status).toBe('degraded');
      expect(calls.every((call) => call.seatId.startsWith('anthropic/'))).toBe(true);

      await expect(
        audience.handle(
          input({
            cwd: directory,
            flags: { personas: 'ops-manager', draft: 'announcement.md' },
            families: ['deepseek', 'moonshot'],
            adapters: { deepseek: adapter('deepseek', 'ok', calls) },
          }),
        ),
      ).rejects.toThrow(/subscription transports only/);
    });
  });

  test('records the draft and one reaction per seat in one session per draft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'convene-audience-records-'));
    await withDraft(async (directory) => {
      await writeFile(join(directory, 'revised.md'), `${DRAFT}\nBring your own mug.\n`);
      const store = ModeSessionStore.open(root);
      const calls: ProviderRequest[] = [];
      const adapters = {
        anthropic: adapter('anthropic', 'ok', calls),
        openai: adapter('openai', 'ok', calls),
        xai: adapter('xai', 'quota-exhausted', calls),
      };
      const first = await audience.handle(
        input({
          cwd: directory,
          flags: { personas: PERSONAS, draft: 'announcement.md' },
          adapters,
          sessions: store,
        }),
      );
      const second = await audience.handle(
        input({
          cwd: directory,
          flags: { personas: PERSONAS, draft: 'revised.md' },
          adapters,
          sessions: store,
        }),
      );
      if (first.kind !== 'result' || second.kind !== 'result') throw new Error('unreachable');

      expect(first.session).not.toBe(second.session);
      expect(AudienceOutputSchema.parse(first.output).draft.sha256).not.toBe(
        AudienceOutputSchema.parse(second.output).draft.sha256,
      );
      expect(first.record.session).toBe(`general/modes/audience/${first.session}.jsonl`);
      expect(first.record.paths).toEqual([store.absolutePath('audience', first.session)]);
      expect(await store.exists('audience', second.session)).toBe(true);

      const events: ModeSessionEvent[] = await store.read('audience', first.session);
      expect(events.map((event) => event.kind)).toEqual([
        'draft',
        'reaction',
        'reaction',
        'reaction',
      ]);
      expect(events[0]?.data).toEqual({
        path: 'announcement.md',
        sha256: AudienceOutputSchema.parse(first.output).draft.sha256,
      });
      expect(events.map((event) => (event.data as { persona: string }).persona).slice(1)).toEqual([
        'ops-manager',
        'new-starter',
        'sceptic',
      ]);
      // A voice that did not answer is recorded as a voice that did not answer.
      expect(events[3]?.data).toMatchObject({ status: 'skipped', code: 'quota-exhausted' });
      expect(events[1]?.data).toMatchObject({ quote: reply('ops-manager').quote });
      expect(first.degraded).not.toContain('records-not-kept: no records root is configured');
    });
    await rm(root, { recursive: true, force: true });
  });

  test('without a records root the run says so rather than losing the record quietly', async () => {
    await withDraft(async (directory) => {
      const calls: ProviderRequest[] = [];
      const outcome = await audience.handle(
        input({
          cwd: directory,
          flags: { personas: 'ops-manager', draft: 'announcement.md' },
          families: ['anthropic'],
          adapters: { anthropic: adapter('anthropic', 'ok', calls) },
        }),
      );
      if (outcome.kind !== 'result') throw new Error('unreachable');
      expect(outcome.record).toEqual({ session: null, paths: [] });
      expect(outcome.degraded).toContain('records-not-kept: no records root is configured');
      // Every voice answered, but the run still could not keep a record of what was said: that is
      // a degraded run, not a completed one that merely mentions the shortfall in passing.
      expect(outcome.status).toBe('degraded');
    });
  });

  test('usage mistakes are refused before any seat is invoked', async () => {
    await withDraft(async (directory) => {
      const calls: ProviderRequest[] = [];
      const adapters = { anthropic: adapter('anthropic', 'ok', calls) };
      const families: readonly ProviderFamily[] = ['anthropic'];
      const cases: [Record<string, string>, RegExp][] = [
        [{ personas: PERSONAS }, /requires --draft/],
        [{ draft: 'announcement.md' }, /--personas <list> or --personas-file/],
        [
          { personas: PERSONAS, 'personas-file': 'readers.json', draft: 'announcement.md' },
          /not both/,
        ],
        [{ personas: PERSONAS, draft: 'absent.md' }, /No draft found/],
        [{ personas: 'a b', draft: 'announcement.md' }, /lens name|persona/i],
      ];
      for (const [flags, message] of cases) {
        await expect(
          audience.handle(input({ cwd: directory, flags, families, adapters })),
        ).rejects.toThrow(message);
      }
      await writeFile(join(directory, 'huge.md'), 'x'.repeat(256 * 1024 + 1));
      await expect(
        audience.handle(
          input({
            cwd: directory,
            flags: { personas: PERSONAS, draft: 'huge.md' },
            families,
            adapters,
          }),
        ),
      ).rejects.toThrow(/the limit is 262144 bytes/);
      expect(calls).toHaveLength(0);
    });
  });
});
