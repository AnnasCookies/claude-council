import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forum } from '../../src/modes/forum';
import type { HandlerCommonOptions, HandlerInput, HandlerOutcome } from '../../src/modes';
import type {
  ModelTransport,
  ProviderFamily,
  SeatResponse,
} from '../../src/substrate/domain/schemas';
import {
  ModeSessionStore,
  createSpendLedger,
  roleCatalogue,
  withCredentialFallback,
  type Availability,
  type HealthResult,
  type ModelRegistry,
  type PanelSpend,
  type PolicyDecision,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderRequest,
} from '../../src/substrate';

const NOW = '2026-09-15T10:00:00.000Z';

const registry: ModelRegistry = {
  anthropic: { primary: 'anthropic-primary', fallbacks: [], transport: 'http' },
  openai: { primary: 'openai-primary', fallbacks: [], transport: 'http' },
  xai: { primary: 'xai-primary', fallbacks: [], transport: 'http' },
  google: { primary: 'google-primary', fallbacks: [], transport: 'http' },
  deepseek: { primary: 'deepseek-primary', fallbacks: [], transport: 'http' },
  moonshot: { primary: 'moonshot-primary', fallbacks: [], transport: 'http' },
};

const allowed = {
  kind: 'allowed',
  reasonCodes: [],
  blockedProviders: [],
  dispositions: [],
  redactions: [],
} as unknown as PolicyDecision;

const blocked = {
  kind: 'blocked',
  reasonCodes: ['restricted-classification'],
  blockedProviders: ['anthropic'],
  dispositions: [],
  redactions: [],
} as unknown as PolicyDecision;

/** The catalogue lens descriptions, keyed by the slug the forum makes of each name. */
const lensDescriptions = new Map(
  roleCatalogue.map((lens) => [
    lens.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, ''),
    lens.prompt,
  ]),
);

function roundOf(prompt: string): number {
  const match = /This is round (\d+) of/u.exec(prompt);
  return match === null ? 0 : Number(match[1]);
}

function ok(
  request: ProviderRequest,
  family: ProviderFamily,
  answer: string,
  extra: Partial<Extract<SeatResponse, { status: 'ok' }>> = {},
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
    latencyMs: 1,
    answer,
    credentialPath: 'subscription',
    ...extra,
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

function forumAnswer(request: ProviderRequest, round: number): string {
  const seat = request.seatId;
  if (round === 1) {
    return JSON.stringify({
      position: 'Keep the sidecar',
      stance: 'hold',
      text: `Opening from ${seat}.`,
      ...(seat.startsWith('anthropic')
        ? { motion: { text: 'Record the sidecar as the default placement.' } }
        : {}),
    });
  }
  return JSON.stringify(
    seat.startsWith('openai')
      ? {
          position: 'Sidecar, with a harness hook',
          stance: 'revise',
          text: `Round ${round} from ${seat}.`,
          inReplyTo: null,
          supports: ['m-1'],
        }
      : {
          // The full stop is deliberate: normalisation means this is not a move.
          position: 'Keep the sidecar.',
          stance: 'hold',
          text: `Round ${round} from ${seat}.`,
          inReplyTo: null,
        },
  );
}

class FakeAdapter implements ProviderAdapter {
  readonly calls: ProviderRequest[] = [];

  constructor(
    readonly family: ProviderFamily,
    private readonly reply: (request: ProviderRequest, round: number) => SeatResponse,
    readonly transport: ModelTransport = 'http',
  ) {}

  async availability(): Promise<Availability> {
    return {
      status: 'available',
      provider: this.family,
      model: registry[this.family].primary,
      reason: '',
    };
  }

  async invoke(request: ProviderRequest): Promise<SeatResponse> {
    this.calls.push(request);
    return this.reply(request, roundOf(request.prompt));
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

function answering(family: ProviderFamily): FakeAdapter {
  return new FakeAdapter(family, (request, round) =>
    ok(request, family, forumAnswer(request, round)),
  );
}

/**
 * Mirrors what `handlerModeCommand` actually hands a mode: a ledger sized from an explicit
 * `--spend-cap` when the options carry one, and from `defaultCap(eligibleFamilies, 1)` (the CLI
 * never knows a handler mode's round count) otherwise. Rebuilt from the merged options, not a
 * fixed literal, so overriding `options.spendCap` in a test also moves the ledger the CLI would
 * really have built for it.
 */
function panelSpendFor(options: HandlerCommonOptions): PanelSpend {
  return {
    policy: 'capped',
    billing: options.billingMode,
    ledger: createSpendLedger(options.spendCap ?? options.eligibleProviderFamilies.length),
  };
}

function input(overrides: Partial<HandlerInput> = {}): HandlerInput {
  const context: ProviderContext = {
    registry,
    env: {},
    cwd: 'C:/isolated/forum',
    timeoutMs: 5_000,
  };
  const options: HandlerCommonOptions = {
    caller: { kind: 'human', harness: 'test', declared: true },
    scope: 'general',
    classification: 'public',
    eligibleProviderFamilies: ['anthropic', 'openai', 'xai'],
    providerFamilies: ['anthropic', 'openai', 'xai'],
    motion: 'Should the advisor live in the harness or a sidecar?',
    timeoutMs: 5_000,
    billingMode: 'sub-first',
    ...overrides.options,
  };
  return {
    command: 'forum',
    flags: new Map([
      ['seats', ['3']],
      ['rounds', ['2']],
    ]),
    positionals: [],
    adapters: {
      anthropic: answering('anthropic'),
      openai: answering('openai'),
      xai: answering('xai'),
    },
    context,
    policyDecision: allowed,
    guard: () => allowed,
    sessions: null,
    now: () => NOW,
    ...overrides,
    // Always the value computed above (or the caller's own explicit override), never whatever
    // `...overrides` alone would leave behind: `options` and `spend` are read together, because a
    // test that moves `options.spendCap` expects the ledger the real CLI would have built for it.
    options,
    spend: overrides.spend ?? panelSpendFor(options),
  };
}

function result(outcome: HandlerOutcome): Extract<HandlerOutcome, { kind: 'result' }> {
  if (outcome.kind !== 'result') throw new Error(`expected a result, got ${outcome.kind}`);
  return outcome;
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'council-forum-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('the forum mode', () => {
  test('is a handler mode that never rules', () => {
    expect(forum.kind).toBe('handler');
    expect(forum.name).toBe('forum');
    expect(forum.pattern).toBe('rounds');
    expect(forum.knobs.records).toContain('ledger');
    expect(forum.spend.policy).toBe('capped');
    expect(forum.spend.defaultCap(6, 3)).toBe(18);
    expect(forum.flags).toEqual({
      value: ['seats', 'rounds', 'lenses', 'personas'],
      boolean: [],
    });
  });

  test('round one is blind: no seat sees another seat in its prompt', async () => {
    const adapters = {
      anthropic: answering('anthropic'),
      openai: answering('openai'),
      xai: answering('xai'),
    };
    const outcome = result(await forum.handle(input({ adapters })));
    const calls = [...adapters.anthropic.calls, ...adapters.openai.calls, ...adapters.xai.calls];
    const opening = calls.filter((call) => roundOf(call.prompt) === 1);
    expect(opening).toHaveLength(3);
    const seatIds = outcome.seats.map((seat) => seat.id);
    for (const call of opening) {
      const lens = call.seatId.split('#')[1] ?? '';
      expect(call.prompt).toContain(lensDescriptions.get(lens) ?? 'missing lens');
      for (const other of seatIds) {
        if (other === call.seatId) continue;
        expect(call.prompt).not.toContain(other);
        const otherLens = other.split('#')[1] ?? '';
        expect(call.prompt).not.toContain(lensDescriptions.get(otherLens) ?? 'missing lens');
      }
      expect(call.prompt).not.toContain('Opening from');
      expect(call.prompt).not.toContain('untrusted');
    }
  });

  test('a later round carries every prior position, attributed to its seat and round', async () => {
    const adapters = {
      anthropic: answering('anthropic'),
      openai: answering('openai'),
      xai: answering('xai'),
    };
    const outcome = result(await forum.handle(input({ adapters })));
    const calls = [...adapters.anthropic.calls, ...adapters.openai.calls, ...adapters.xai.calls];
    const replies = calls.filter((call) => roundOf(call.prompt) === 2);
    expect(replies).toHaveLength(3);
    for (const call of replies) {
      for (const seat of outcome.seats) {
        expect(call.prompt).toContain(`Round 1, seat ${seat.id} (stance: hold)`);
        expect(call.prompt).toContain(`Opening from ${seat.id}`);
      }
      expect(call.prompt).toContain('<untrusted-prior-position>');
      expect(call.prompt).toContain('m-1, raised by anthropic/anthropic-primary#');
    }
  });

  test('reports the rounds, the map, the move and the motion, and rules on none of it', async () => {
    const outcome = result(await forum.handle(input()));
    expect(outcome.status).toBe('degraded');
    expect(outcome.pattern).toBe('rounds');
    expect(outcome.rounds).toBe(2);
    // No `--records-root` is configured in this fixture, so the run has nowhere to keep the
    // ledger it exists to keep; that is the one degraded reason here.
    expect(outcome.degraded).toEqual(['records-not-kept: no records root is configured']);
    expect(outcome.synthesis).toBeNull();
    expect(outcome.dissent).toBeNull();
    expect(outcome.unanimous).toBe(false);
    expect(outcome.session).toMatch(/^fo-2026-09-15-[a-f0-9]{6}$/);
    expect(outcome.record).toEqual({ session: null, paths: [] });
    expect(outcome.seats.map((seat) => seat.status)).toEqual(['ok', 'ok', 'ok']);
    expect(outcome.seats.map((seat) => seat.family)).toEqual(['anthropic', 'openai', 'xai']);
    // No `--spend-cap` was given and the CLI's own ledger assumed one round: the forum rebuilds it
    // sized on the real seat and round count (3 seats x 2 rounds), so nothing is starved.
    expect(outcome.spend.cap).toBe(6);

    const output = forum.outputSchema.parse(outcome.output) as {
      rounds: { n: number; positions: { seat: string }[] }[];
      map: { position: string; holders: string[] }[];
      moved: { seat: string; round: number; from: string; to: string; why: string }[];
      motions: { id: string; by: string; text: string; support: string[]; opposed: string[] }[];
    };
    expect(output.rounds.map((round) => round.n)).toEqual([1, 2]);
    expect(output.rounds[0]?.positions).toHaveLength(3);
    expect(output.map).toEqual([
      {
        position: 'Keep the sidecar.',
        holders: ['anthropic/anthropic-primary#strategist', 'xai/xai-primary#designer'],
      },
      { position: 'Sidecar, with a harness hook', holders: ['openai/openai-primary#architect'] },
    ]);
    expect(output.moved).toEqual([
      {
        seat: 'openai/openai-primary#architect',
        round: 2,
        from: 'Keep the sidecar',
        to: 'Sidecar, with a harness hook',
        why: 'Round 2 from openai/openai-primary#architect.',
      },
    ]);
    expect(output.motions).toEqual([
      {
        id: 'm-1',
        by: 'anthropic/anthropic-primary#strategist',
        text: 'Record the sidecar as the default placement.',
        support: ['openai/openai-primary#architect'],
        opposed: [],
      },
    ]);
  });

  test('writes one round event per round with every raw seat answer and status', async () => {
    await withRoot(async (root) => {
      const sessions = ModeSessionStore.open(root);
      const outcome = result(await forum.handle(input({ sessions })));
      expect(outcome.status).toBe('completed');
      expect(outcome.degraded).toEqual([]);
      expect(outcome.record.session).toBe(`general/modes/forum/${outcome.session}.jsonl`);
      expect(outcome.record.paths).toEqual([sessions.absolutePath('forum', outcome.session)]);

      const events = await sessions.read('forum', outcome.session);
      expect(events.map((event) => event.kind)).toEqual(['opened', 'round', 'round', 'closed']);
      const opened = events[0]?.data as { motion: string; rounds: number; cap: number };
      expect(opened.motion).toContain('sidecar');
      expect(opened.rounds).toBe(2);
      expect(opened.cap).toBe(6);
      const first = events[1]?.data as {
        n: number;
        seats: { id: string; status: string; raw?: string }[];
        answers: { seat: string; answer: { position: string } }[];
      };
      expect(first.n).toBe(1);
      expect(first.seats.map((seat) => seat.status)).toEqual(['ok', 'ok', 'ok']);
      expect(first.seats[0]?.raw).toContain('Opening from');
      expect(first.answers[0]?.answer.position).toBe('Keep the sidecar');
      expect(events[3]?.data).toEqual({ rounds: 2, reason: 'round-limit' });
    });
  });

  test('the cap stops the rounds and the ledger says why', async () => {
    await withRoot(async (root) => {
      const sessions = ModeSessionStore.open(root);
      // The metered path has to say it was metered, or nothing downstream can count what was spent.
      const metered = new FakeAdapter('xai', (request, round) =>
        ok(request, 'xai', forumAnswer(request, round), { credentialPath: 'api-key' }),
      );
      const subscription = new FakeAdapter('xai', (request) =>
        failed(request, 'xai', 'quota-exhausted'),
      );
      const outcome = result(
        await forum.handle(
          input({
            sessions,
            flags: new Map([
              ['seats', ['3']],
              ['rounds', ['3']],
            ]),
            options: { ...input().options, spendCap: 1 },
            adapters: {
              anthropic: answering('anthropic'),
              openai: answering('openai'),
              xai: withCredentialFallback(subscription, () => metered, 'http'),
            },
          }),
        ),
      );
      expect(outcome.status).toBe('degraded');
      expect(outcome.rounds).toBe(2);
      expect(outcome.degraded).toContain('rounds-not-completed: ran 2 of 3');
      expect(outcome.degraded).toContain('seat-answers-missing');
      // `spend-cap-reached` is the CLI's to add from `spend.stoppedAtCap`, not the mode's.
      expect(outcome.degraded).not.toContain('spend-cap-reached');
      // An explicit `--spend-cap` is the caller's own number: the forum never second-guesses it.
      expect(outcome.spend).toEqual({
        billing: 'sub-first',
        policy: 'capped',
        cap: 1,
        used: 1,
        fallbacks: 1,
        refused: 1,
        stoppedAtCap: true,
      });
      const events = await sessions.read('forum', outcome.session);
      expect(events.map((event) => event.kind)).toEqual(['opened', 'round', 'round', 'closed']);
      expect(events[3]?.data).toEqual({ rounds: 2, reason: 'spend-cap' });
      expect(metered.calls).toHaveLength(1);
    });
  });

  test('a seat that answers off-shape keeps its raw text and leaves the positions honest', async () => {
    // The panel judges the answer, not the forum: an off-shape reply is an invalid seat whose raw
    // text stays on the record, and it simply holds no position in this round.
    const outcome = result(
      await forum.handle(
        input({
          adapters: {
            anthropic: answering('anthropic'),
            openai: answering('openai'),
            xai: new FakeAdapter('xai', (request) =>
              ok(request, 'xai', 'I would keep the sidecar.'),
            ),
          },
        }),
      ),
    );
    expect(outcome.status).toBe('degraded');
    // No records root in this fixture either, so the missing-record reason is degraded too.
    expect(outcome.degraded).toEqual([
      'seat-answers-missing',
      'records-not-kept: no records root is configured',
    ]);
    expect(outcome.seats[2]).toMatchObject({ status: 'invalid', family: 'xai' });
    const output = forum.outputSchema.parse(outcome.output) as {
      rounds: { positions: { seat: string }[] }[];
    };
    for (const round of output.rounds) {
      expect(round.positions.map((position) => position.seat)).not.toContain(
        'xai/xai-primary#designer',
      );
    }
  });

  test('refuses the usage mistakes before any seat is invoked', async () => {
    const adapters = {
      anthropic: answering('anthropic'),
      openai: answering('openai'),
      xai: answering('xai'),
    };
    const base = input({ adapters });
    // `motion` is dropped rather than set to undefined: under exactOptionalPropertyTypes those are
    // different things, and the CLI drops the key when no --motion was given.
    const { motion: _motion, ...withoutMotion } = base.options;
    await expect(forum.handle({ ...base, options: withoutMotion })).rejects.toThrow(
      /requires --motion/,
    );
    await expect(forum.handle({ ...base, flags: new Map([['seats', ['1']]]) })).rejects.toThrow(
      /--seats must be an integer from 2 to 24/,
    );
    await expect(forum.handle({ ...base, flags: new Map([['rounds', ['7']]]) })).rejects.toThrow(
      /--rounds must be an integer from 1 to 6/,
    );
    await expect(
      forum.handle({
        ...base,
        flags: new Map([
          ['lenses', ['critic']],
          ['personas', ['./personas.json']],
        ]),
      }),
    ).rejects.toThrow(/not both/);
    await expect(
      forum.handle({ ...base, flags: new Map([['lenses', ['nobody']]]) }),
    ).rejects.toThrow(/Unknown lens: nobody/);
    expect(adapters.anthropic.calls).toHaveLength(0);
  });

  test('supplied personas go through the outbound policy before any seat is invoked', async () => {
    await withRoot(async (root) => {
      const personas = join(root, 'personas.json');
      await Bun.write(
        personas,
        JSON.stringify([
          { name: 'Ops manager', description: 'Runs the rota and carries the pager.' },
          { name: 'New starter', description: 'Joined last week and knows none of the history.' },
        ]),
      );
      const adapters = {
        anthropic: answering('anthropic'),
        openai: answering('openai'),
        xai: answering('xai'),
      };
      const base = input({ adapters });
      const refused = await forum.handle({
        ...base,
        flags: new Map([
          ['seats', ['2']],
          ['rounds', ['1']],
          ['personas', [personas]],
        ]),
        context: { ...base.context, cwd: root },
        guard: () => blocked,
      });
      expect(refused).toMatchObject({ kind: 'blocked', status: 'blocked-policy' });
      expect(adapters.anthropic.calls).toHaveLength(0);

      const allowedRun = result(
        await forum.handle({
          ...base,
          flags: new Map([
            ['seats', ['2']],
            ['rounds', ['1']],
            ['personas', [personas]],
          ]),
          context: { ...base.context, cwd: root },
        }),
      );
      expect(allowedRun.seats.map((seat) => seat.lens)).toEqual(['ops-manager', 'new-starter']);
      expect(adapters.anthropic.calls[0]?.prompt).toContain('Runs the rota and carries the pager.');
    });
  });

  test('seats beyond the lens list are dealt again, and say so in their names', async () => {
    const outcome = result(
      await forum.handle(
        input({
          flags: new Map([
            ['seats', ['4']],
            ['rounds', ['1']],
            ['lenses', ['critic,security']],
          ]),
        }),
      ),
    );
    expect(outcome.seats.map((seat) => seat.lens)).toEqual([
      'critic',
      'security',
      'critic-2',
      'security-2',
    ]);
    expect(new Set(outcome.seats.map((seat) => seat.id)).size).toBe(4);
  });

  test('the rebuilt default cap scales with --seats, not with the eligible family count', async () => {
    // Still the fixture's 3 eligible families throughout: a cap that tracked family count instead
    // of seat count would stay 6 here, exactly as it does for the 3-seat case above.
    const outcome = result(
      await forum.handle(
        input({
          flags: new Map([
            ['seats', ['5']],
            ['rounds', ['2']],
          ]),
        }),
      ),
    );
    expect(outcome.spend.cap).toBe(10);
  });

  test('cycled lens names stay distinct even when a persona already claims a would-be cycle name', async () => {
    await withRoot(async (root) => {
      const personas = join(root, 'personas.json');
      await Bun.write(
        personas,
        JSON.stringify([
          { name: 'Critic', description: 'The first critic seat.' },
          // Slugs to `critic-2`, which is exactly the name cycling would mint for a third seat
          // repeating `Critic`.
          { name: 'Critic 2', description: 'A persona that already claims the second slot.' },
        ]),
      );
      const base = input();
      await expect(
        forum.handle({
          ...base,
          flags: new Map([
            ['seats', ['3']],
            ['rounds', ['1']],
            ['personas', [personas]],
          ]),
          context: { ...base.context, cwd: root },
        }),
      ).rejects.toThrow(/Lens names collide/);
    });
  });

  test('a persona name is scanned by the outbound guard too, not only its description', async () => {
    await withRoot(async (root) => {
      const personas = join(root, 'personas.json');
      await Bun.write(
        personas,
        JSON.stringify([
          { name: 'Restricted Codename', description: 'An ordinary description.' },
          { name: 'Second seat', description: 'Also an ordinary description.' },
        ]),
      );
      const adapters = {
        anthropic: answering('anthropic'),
        openai: answering('openai'),
        xai: answering('xai'),
      };
      const base = input({ adapters });
      const refused = await forum.handle({
        ...base,
        flags: new Map([
          ['seats', ['2']],
          ['rounds', ['1']],
          ['personas', [personas]],
        ]),
        context: { ...base.context, cwd: root },
        // Blocks on the slugged persona *name* only, never on either description, so this can only
        // pass if the name itself reached the guard.
        guard: (payloads) => (payloads.includes('restricted-codename') ? blocked : allowed),
      });
      expect(refused).toMatchObject({ kind: 'blocked', status: 'blocked-policy' });
      expect(adapters.anthropic.calls).toHaveLength(0);
    });
  });
});
