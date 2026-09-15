import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { ideation, ideationPrompt } from '../../src/modes/ideation';
import { IdeationOutputSchema, readIdeationSession } from '../../src/modes/ideation/session';
import type { HandlerInput } from '../../src/modes';
import {
  ModeSessionStore,
  ProviderFamilySchema,
  createSpendLedger,
  type ModelRegistry,
  type PanelSpend,
  type PolicyDecision,
  type ProviderAdapter,
  type ProviderFamily,
  type ProviderRequest,
  type SeatResponse,
} from '../../src/substrate';

const NOW = '2026-09-15T10:00:00.000Z';
const SESSION = 'id-2026-09-15-0a1b2c';

const registry: ModelRegistry = {
  anthropic: { primary: 'anthropic-pro', fallbacks: [], transport: 'http' },
  openai: { primary: 'openai-pro', fallbacks: [], transport: 'http' },
  xai: { primary: 'xai-pro', fallbacks: ['xai-lite'], transport: 'http' },
  google: { primary: 'google-pro', fallbacks: ['google-lite'], transport: 'http' },
  deepseek: { primary: 'deepseek-pro', fallbacks: ['deepseek-lite'], transport: 'http' },
  moonshot: { primary: 'moonshot-pro', fallbacks: [], transport: 'http' },
};

function cheapModel(family: ProviderFamily): string {
  const route = registry[family];
  return route.fallbacks[0] ?? route.primary;
}

const allowed = {
  kind: 'allowed',
  reasonCodes: [],
  blockedProviders: [],
  dispositions: [],
  redactions: [],
} as unknown as PolicyDecision;

const blocked = { ...allowed, kind: 'blocked' } as unknown as PolicyDecision;

type Reply = (lens: string) => string;

function lensOf(request: ProviderRequest): string {
  return request.role;
}

interface Fixture {
  readonly input: HandlerInput;
  readonly calls: () => ProviderRequest[];
}

/**
 * The default seat count `ideation` falls back to when `--seats` is absent. Mirrored here rather
 * than imported, because a fixture default is not part of the mode's public surface.
 */
const DEFAULT_SEATS_FOR_CAP = 12;

/**
 * `HandlerInput.spend` is a `PanelSpend` the CLI builds before the handler ever runs (from
 * `--spend-cap` or `mode.spend.defaultCap(eligibleFamilies, 1)`). A fixture stands in for the CLI,
 * so it sizes the ledger itself: the explicit `spendCap` when the test asked for one, otherwise
 * the seat count `--seats` requests, which is what the mode's own `defaultCap` would size it to
 * once it echoes back the family count it is given.
 */
function fixtureSpend(options: {
  readonly flags?: Record<string, readonly string[]>;
  readonly spendCap?: number;
}): PanelSpend {
  const requestedSeats = Number(options.flags?.seats?.[0] ?? DEFAULT_SEATS_FOR_CAP);
  const cap = options.spendCap ?? requestedSeats;
  return { policy: 'capped', billing: 'sub-first', ledger: createSpendLedger(cap) };
}

function build(options: {
  readonly root: string | null;
  readonly flags?: Record<string, readonly string[]>;
  readonly families?: readonly ProviderFamily[];
  readonly sessionId?: string;
  readonly motion?: string;
  readonly reply?: Reply;
  readonly guard?: HandlerInput['guard'];
  readonly spendCap?: number;
}): Fixture {
  const calls: ProviderRequest[] = [];
  const reply =
    options.reply ?? ((lens: string) => JSON.stringify({ ideas: [{ text: `${lens} one` }] }));
  const adapters = Object.fromEntries(
    ProviderFamilySchema.options.map((family) => [
      family,
      {
        family,
        transport: 'http',
        async availability() {
          return {
            status: 'available' as const,
            provider: family,
            model: cheapModel(family),
            reason: '',
          };
        },
        async invoke(request: ProviderRequest): Promise<SeatResponse> {
          calls.push(request);
          return {
            status: 'ok',
            seatId: request.seatId,
            provider: family,
            requestedModel: cheapModel(family),
            actualModel: cheapModel(family),
            modelIdentity: 'verified',
            route: 'primary',
            role: request.role,
            latencyMs: 1,
            credentialPath: 'subscription',
            answer: reply(lensOf(request)),
          };
        },
        async probe() {
          return {
            status: 'healthy' as const,
            provider: family,
            requestedModel: cheapModel(family),
            actualModel: cheapModel(family),
            latencyMs: 1,
            reason: '',
          };
        },
      } satisfies ProviderAdapter,
    ]),
  ) as Partial<Record<ProviderFamily, ProviderAdapter>>;

  const families = options.families ?? (['xai', 'google'] as const);
  const input: HandlerInput = {
    command: 'ideate',
    options: {
      caller: { kind: 'human', harness: 'test', declared: true },
      scope: 'general',
      classification: 'public',
      eligibleProviderFamilies: [...families],
      providerFamilies: [...families],
      ...(options.motion === undefined ? {} : { motion: options.motion }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      timeoutMs: 5_000,
      billingMode: 'sub-first',
      ...(options.root === null ? {} : { recordsRoot: options.root }),
    },
    flags: new Map(Object.entries(options.flags ?? {})),
    positionals: [],
    adapters,
    context: { registry, env: {}, cwd: 'C:/isolated/ideation', timeoutMs: 5_000 },
    policyDecision: allowed,
    guard: options.guard ?? (() => allowed),
    sessions: options.root === null ? null : ModeSessionStore.open(options.root),
    spend: fixtureSpend(options),
    now: () => NOW,
  };
  return { input, calls: () => calls };
}

const twoIdeas: Reply = (lens) =>
  JSON.stringify({ ideas: [{ text: `${lens} one` }, { text: 'shared idea about notes' }] });

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'council-ideation-'));
}

/**
 * Write a session log holding `count` recorded ideas, without running the passes that would have
 * produced them. Reaching the session ceiling through the handler would cost hundreds of panel
 * calls; the ceiling is a property of the log, so the log is what the fixture supplies.
 */
async function seedSessionLog(
  root: string,
  sessionId: string,
  prompt: string,
  count: number,
): Promise<string> {
  const store = ModeSessionStore.open(root);
  const path = store.absolutePath('ideation', sessionId);
  await mkdir(join(root, 'general', 'modes', 'ideation'), { recursive: true });
  const ideas = Array.from({ length: count }, (_, index) => ({
    id: `i-${index + 1}`,
    seat: 'xai/xai-lite#strategist',
    lens: 'strategist',
    text: `recorded idea ${index + 1}`,
  }));
  const lines = [
    {
      at: NOW,
      kind: 'pass',
      data: { n: 1, scope: 'all', prompt, ideasPerSeat: 1, seats: [], invalid: [], ideas },
    },
    { at: NOW, kind: 'cluster', data: { n: 1, clusters: [], nextClusterNumber: 1 } },
  ];
  await Bun.write(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  return path;
}

describe('ideation prompt', () => {
  test('a first pass carries the prompt and the lens, and nothing else', () => {
    const text = ideationPrompt({
      lens: { name: 'security', description: 'Look for the attack path.' },
      prompt: 'Ways to make advisor notes visible',
      ideasPerSeat: 3,
      scoped: [],
    });
    expect(text).toContain('Lens: security');
    expect(text).toContain('Look for the attack path.');
    expect(text).toContain('Ways to make advisor notes visible');
    expect(text).toContain('at most 3 ideas');
    expect(text).toContain('Do not rank');
    expect(text).not.toContain('untrusted-ideas');
  });

  test('an expansion pass carries only the ideas it was handed, as bounded data', () => {
    const text = ideationPrompt({
      lens: { name: 'security', description: 'Look for the attack path.' },
      prompt: 'Ways to make advisor notes visible',
      ideasPerSeat: 2,
      scoped: [
        { cluster: 'k-2', text: 'Show notes in the status line' },
        { cluster: 'k-2', text: 'Show notes in a status bar' },
      ],
    });
    expect(text.startsWith('Evidence envelope rule:')).toBe(true);
    expect(text).toContain('<untrusted-ideas>');
    expect(text).toContain('k-2: Show notes in the status line');
    expect(text).toContain('belong inside those groups');
    // Nothing from an unexpanded cluster can reach the prompt, because the builder is given the
    // scoped ideas and has no other source of prior material.
    expect(text).not.toContain('Colour code notes');
  });
});

describe('ideation handler', () => {
  test('runs one blind pass, numbers every idea and writes both session lines', async () => {
    const root = await temporaryRoot();
    try {
      const fixture = build({
        root,
        sessionId: SESSION,
        motion: 'Ways to make advisor notes visible',
        flags: { seats: ['4'], 'ideas-per-seat': ['2'] },
        reply: twoIdeas,
      });
      const outcome = await ideation.handle(fixture.input);
      expect(outcome.kind).toBe('result');
      if (outcome.kind !== 'result') throw new Error('unreachable');
      expect(outcome.status).toBe('completed');
      expect(outcome.session).toBe(SESSION);
      expect(outcome.pattern).toBe('parallel');
      expect(outcome.rounds).toBe(1);
      expect(outcome.synthesis).toBeNull();
      expect(outcome.dissent).toBeNull();
      expect(outcome.unanimous).toBe(false);
      expect(outcome.degraded).toEqual([]);

      // Cheap seats, spread round-robin over the two chosen families.
      expect(outcome.seats.map((seat) => seat.id)).toEqual([
        'xai/xai-lite#strategist',
        'google/google-lite#architect',
        'xai/xai-lite#designer',
        'google/google-lite#researcher',
      ]);
      expect(outcome.seats.every((seat) => seat.model.verification === 'verified')).toBe(true);
      expect(outcome.spend).toMatchObject({
        billing: 'sub-first',
        policy: 'capped',
        cap: 4,
        used: 0,
        stoppedAtCap: false,
      });

      const output = IdeationOutputSchema.parse(outcome.output);
      expect(output.prompt).toBe('Ways to make advisor notes visible');
      expect(output.passes).toHaveLength(1);
      expect(output.passes[0]?.scope).toBe('all');
      expect(output.raw).toEqual(['i-1', 'i-2', 'i-3', 'i-4', 'i-5', 'i-6', 'i-7', 'i-8']);
      expect(output.passes[0]?.ideas.map((idea) => idea.id)).toEqual(output.raw);
      expect(output.passes[0]?.ideas[0]).toEqual({
        id: 'i-1',
        seat: 'xai/xai-lite#strategist',
        lens: 'strategist',
        text: 'strategist one',
      });
      expect(output.clusters).toEqual([
        { id: 'k-1', label: 'strategist one', ideaIds: ['i-1'] },
        { id: 'k-2', label: 'shared idea notes', ideaIds: ['i-2', 'i-4', 'i-6', 'i-8'] },
        { id: 'k-3', label: 'architect one', ideaIds: ['i-3'] },
        { id: 'k-4', label: 'designer one', ideaIds: ['i-5'] },
        { id: 'k-5', label: 'researcher one', ideaIds: ['i-7'] },
      ]);

      expect(outcome.record.session).toBe(`general/modes/ideation/${SESSION}.jsonl`);
      expect(outcome.record.paths).toEqual([
        join(root, 'general', 'modes', 'ideation', `${SESSION}.jsonl`),
      ]);
      const lines = (await Bun.file(outcome.record.paths[0] ?? '').text()).trimEnd().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0] ?? '')).toMatchObject({ at: NOW, kind: 'pass' });
      expect(JSON.parse(lines[1] ?? '')).toMatchObject({
        at: NOW,
        kind: 'cluster',
        data: { n: 1, nextClusterNumber: 6 },
      });

      // Blind: no seat's prompt mentions any other seat, and no prompt carries an idea at all.
      for (const request of fixture.calls()) {
        expect(request.prompt).not.toContain('shared idea about notes');
        expect(request.prompt).toContain('Ways to make advisor notes visible');
      }
      expect(fixture.calls()).toHaveLength(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('mints a session id when none was given', async () => {
    const root = await temporaryRoot();
    try {
      const outcome = await ideation.handle(
        build({ root, motion: 'A fresh room', flags: { seats: ['1'] } }).input,
      );
      if (outcome.kind !== 'result') throw new Error('unreachable');
      expect(outcome.session).toMatch(/^id-2026-09-15-[a-f0-9]{6}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps the first N ideas of a generous seat and marks an empty answer invalid', async () => {
    const root = await temporaryRoot();
    try {
      const fixture = build({
        root,
        sessionId: SESSION,
        motion: 'A short room',
        families: ['xai'],
        flags: { seats: ['2'], 'ideas-per-seat': ['2'] },
        reply: (lens) =>
          lens === 'strategist'
            ? JSON.stringify({
                ideas: [
                  { text: 'aaa one' },
                  { text: 'bbb two' },
                  { text: 'ccc three' },
                  { text: 'ddd four' },
                  { text: 'eee five' },
                ],
              })
            : JSON.stringify({ ideas: [] }),
      });
      const outcome = await ideation.handle(fixture.input);
      if (outcome.kind !== 'result') throw new Error('unreachable');
      // Extras are generosity, not error: the seat stays `ok` and the first two ideas are kept.
      expect(outcome.status).toBe('degraded');
      expect(outcome.degraded).toEqual(['seats-unanswered: 1']);
      expect(outcome.seats.map((seat) => seat.status)).toEqual(['ok', 'invalid']);
      const output = IdeationOutputSchema.parse(outcome.output);
      expect(output.raw).toEqual(['i-1', 'i-2']);
      expect(output.passes[0]?.ideas.map((idea) => idea.text)).toEqual(['aaa one', 'bbb two']);

      const first = (await Bun.file(outcome.record.paths[0] ?? '').text()).split('\n')[0] ?? '';
      expect(JSON.parse(first).data.invalid).toEqual([
        { seat: 'xai/xai-lite#architect', raw: '{"ideas":[]}' },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('an expansion pass scopes to the named clusters and continues the numbering', async () => {
    const root = await temporaryRoot();
    try {
      await ideation.handle(
        build({
          root,
          sessionId: SESSION,
          motion: 'Ways to make advisor notes visible',
          flags: { seats: ['4'], 'ideas-per-seat': ['2'] },
          reply: twoIdeas,
        }).input,
      );
      const second = build({
        root,
        sessionId: SESSION,
        flags: { seats: ['4'], 'ideas-per-seat': ['2'], expand: ['k-2'] },
        reply: (lens) => JSON.stringify({ ideas: [{ text: `${lens} expanded note` }] }),
      });
      const outcome = await ideation.handle(second.input);
      if (outcome.kind !== 'result') throw new Error('unreachable');
      expect(outcome.status).toBe('completed');

      const output = IdeationOutputSchema.parse(outcome.output);
      expect(output.passes.map((pass) => [pass.n, pass.scope])).toEqual([
        [1, 'all'],
        [2, ['k-2']],
      ]);
      expect(output.passes[1]?.ideas.map((idea) => idea.id)).toEqual([
        'i-9',
        'i-10',
        'i-11',
        'i-12',
      ]);
      expect(output.raw).toHaveLength(12);
      expect(output.raw[11]).toBe('i-12');
      // Every id the first pass issued survives; the new group takes the next free number.
      expect(output.clusters.map((cluster) => cluster.id)).toEqual([
        'k-1',
        'k-2',
        'k-3',
        'k-4',
        'k-5',
        'k-6',
      ]);
      expect(output.clusters[5]).toEqual({
        id: 'k-6',
        label: 'expanded note strategist',
        ideaIds: ['i-9', 'i-10', 'i-11', 'i-12'],
      });

      // Only the expanded cluster's ideas reach a prompt, and they arrive as bounded data.
      for (const request of second.calls()) {
        expect(request.prompt).toContain('k-2: shared idea about notes');
        expect(request.prompt).toContain('<untrusted-ideas>');
        expect(request.prompt).not.toContain('strategist one');
        expect(request.prompt).not.toContain('architect one');
      }

      const lines = (await Bun.file(outcome.record.paths[0] ?? '').text()).trimEnd().split('\n');
      expect(lines).toHaveLength(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses an unknown cluster id, an expansion without a session and a missing records root, before any seat', async () => {
    const root = await temporaryRoot();
    try {
      const seeded = build({
        root,
        sessionId: SESSION,
        motion: 'Ways to make advisor notes visible',
        flags: { seats: ['2'], 'ideas-per-seat': ['1'] },
      });
      await ideation.handle(seeded.input);

      const unknown = build({
        root,
        sessionId: SESSION,
        flags: { seats: ['2'], expand: ['k-2,k-9'] },
      });
      await expect(ideation.handle(unknown.input)).rejects.toThrow(
        /Unknown cluster id: k-9\. This session has k-1, k-2\./,
      );
      expect(unknown.calls()).toHaveLength(0);

      const unseated = build({ root, flags: { expand: ['k-1'] }, motion: 'No session here' });
      await expect(ideation.handle(unseated.input)).rejects.toThrow(/--expand continues/);
      expect(unseated.calls()).toHaveLength(0);

      const rootless = build({ root: null, motion: 'Nowhere to write' });
      await expect(ideation.handle(rootless.input)).rejects.toThrow(/--records-root/);
      expect(rootless.calls()).toHaveLength(0);

      const contradictory = build({
        root,
        sessionId: SESSION,
        motion: 'A different question',
        flags: { seats: ['2'] },
      });
      await expect(ideation.handle(contradictory.input)).rejects.toThrow(/different prompt/);
      expect(contradictory.calls()).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a blocked payload stops the pass before any seat is invoked', async () => {
    const root = await temporaryRoot();
    try {
      const fixture = build({
        root,
        sessionId: SESSION,
        motion: 'A blocked room',
        flags: { seats: ['2'] },
        guard: () => blocked,
      });
      const outcome = await ideation.handle(fixture.input);
      expect(outcome).toMatchObject({ kind: 'blocked', status: 'blocked-policy' });
      expect(fixture.calls()).toHaveLength(0);
      expect(
        await Bun.file(join(root, 'general', 'modes', 'ideation', `${SESSION}.jsonl`)).exists(),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('declares its knobs, its flags and a family-sized default spend cap', async () => {
    expect(ideation.kind).toBe('handler');
    expect(ideation.name).toBe('ideation');
    expect(ideation.pattern).toBe('parallel');
    expect(ideation.spend.policy).toBe('capped');
    expect(ideation.flags).toEqual({
      value: ['seats', 'lenses', 'personas', 'ideas-per-seat', 'models', 'expand'],
      boolean: [],
    });
    // The CLI calls this with the eligible family count and always one pass, before the mode has
    // resolved its seats; a metered fallback draws on its own family's credential, so one refusal
    // per family bounds a pass regardless of how many lenses land on it, and the round count is
    // not part of that.
    expect(ideation.spend.defaultCap(12, 2)).toBe(12);
    expect(ideation.knobs.aggregation).toContain('never ranked');

    const root = await temporaryRoot();
    try {
      const outcome = await ideation.handle(
        build({ root, motion: 'Capped', flags: { seats: ['2'] }, spendCap: 7 }).input,
      );
      if (outcome.kind !== 'result') throw new Error('unreachable');
      expect(outcome.spend.cap).toBe(7);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('ideation usage errors', () => {
  test('refuses a pass that would take the session past its idea ceiling', async () => {
    const root = await temporaryRoot();
    try {
      const prompt = 'Ways to make advisor notes visible';
      const path = await seedSessionLog(root, SESSION, prompt, 1999);
      const before = await Bun.file(path).text();

      const fixture = build({
        root,
        sessionId: SESSION,
        motion: prompt,
        families: ['xai'],
        flags: { seats: ['2'], 'ideas-per-seat': ['1'] },
      });
      await expect(ideation.handle(fixture.input)).rejects.toThrow(
        /An ideation session holds at most 2000 ideas; this one holds 1999 and this pass would add 2\. Open a new session by leaving --session off\./,
      );
      // The ceiling is a property of the log, so it is read under the lock like the prompt is: the
      // seats have already answered by then, and the refusal costs the record nothing.
      expect(fixture.calls()).toHaveLength(2);
      expect(await Bun.file(path).text()).toBe(before);
      expect(
        readIdeationSession(await ModeSessionStore.open(root).read('ideation', SESSION)).ideas,
      ).toHaveLength(1999);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses a persona list beside a lens list, before the file is even read', async () => {
    const root = await temporaryRoot();
    try {
      const fixture = build({
        root,
        motion: 'Two ways to seat the room',
        flags: { personas: [join(root, 'never-read.json')], lenses: ['security'] },
      });
      await expect(ideation.handle(fixture.input)).rejects.toThrow(
        /--personas supplies the seats itself; it cannot be combined with --lenses/,
      );
      expect(fixture.calls()).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses a cluster named twice in --expand', async () => {
    const root = await temporaryRoot();
    try {
      await ideation.handle(
        build({
          root,
          sessionId: SESSION,
          motion: 'Ways to make advisor notes visible',
          flags: { seats: ['2'], 'ideas-per-seat': ['1'] },
        }).input,
      );
      const twice = build({ root, sessionId: SESSION, flags: { expand: ['k-1,k-1'] } });
      await expect(ideation.handle(twice.input)).rejects.toThrow(/Option --expand names k-1 twice/);
      expect(twice.calls()).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses a room or an idea count outside its range, at both ends', async () => {
    const root = await temporaryRoot();
    try {
      const cases: [Record<string, readonly string[]>, RegExp][] = [
        [{ seats: ['0'] }, /--seats must be an integer from 1 to 24/],
        [{ seats: ['25'] }, /--seats must be an integer from 1 to 24/],
        [{ seats: ['2.5'] }, /--seats must be an integer from 1 to 24/],
        [{ 'ideas-per-seat': ['0'] }, /--ideas-per-seat must be an integer from 1 to 10/],
        [{ 'ideas-per-seat': ['11'] }, /--ideas-per-seat must be an integer from 1 to 10/],
      ];
      for (const [flags, message] of cases) {
        // The ledger is sized explicitly: the fixture stands in for the CLI, and the CLI would
        // never have reached this mode with a seat count it could not size a cap from.
        const fixture = build({ root, motion: 'Out of range', flags, spendCap: 1 });
        await expect(ideation.handle(fixture.input)).rejects.toThrow(message);
        expect(fixture.calls()).toHaveLength(0);
      }
      // A flag repeated is a usage error too, and it is the shared reader that says so.
      const repeated = build({
        root,
        motion: 'Twice over',
        flags: { seats: ['2', '3'] },
        spendCap: 1,
      });
      await expect(ideation.handle(repeated.input)).rejects.toThrow(
        /Option --seats may be provided only once/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('names --motion when the room has no prompt to open on', async () => {
    const root = await temporaryRoot();
    try {
      const fixture = build({ root, flags: { seats: ['1'] } });
      await expect(ideation.handle(fixture.input)).rejects.toThrow(
        /ideate opens a room on a prompt: pass a non-blank --motion/,
      );
      expect(fixture.calls()).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('--models puts the named model on the seat specs the panel is given', async () => {
    const root = await temporaryRoot();
    try {
      const fixture = build({
        root,
        sessionId: SESSION,
        motion: 'Whose model answers',
        families: ['xai', 'google'],
        flags: { seats: ['2'], 'ideas-per-seat': ['1'], models: ['xai=xai-tiny'] },
      });
      const outcome = await ideation.handle(fixture.input);
      if (outcome.kind !== 'result') throw new Error('unreachable');
      // The override reaches the seat id and the requested model; the family it did not name keeps
      // the cheap fallback the registry lists.
      expect(outcome.seats.map((seat) => [seat.id, seat.model.requested])).toEqual([
        ['xai/xai-tiny#strategist', 'xai-tiny'],
        ['google/google-lite#architect', 'google-lite'],
      ]);
      expect(fixture.calls().map((request) => request.seatId)).toEqual([
        'xai/xai-tiny#strategist',
        'google/google-lite#architect',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('ideation under concurrent calls', () => {
  test('two concurrent first passes mint distinct, sequential ids and leave a readable log', async () => {
    const root = await temporaryRoot();
    try {
      const call = () =>
        ideation.handle(
          build({
            root,
            sessionId: SESSION,
            motion: 'Ways to make advisor notes visible',
            families: ['xai'],
            flags: { seats: ['2'], 'ideas-per-seat': ['1'] },
          }).input,
        );
      const outcomes = await Promise.all([call(), call()]);
      const outputs = outcomes.map((outcome) => {
        if (outcome.kind !== 'result') throw new Error('unreachable');
        return IdeationOutputSchema.parse(outcome.output);
      });

      // One pass each, numbered in the order the log settled them rather than the order the panels
      // returned, and neither call reused the other's idea numbers.
      const passNumbers = outputs.map((output) => output.passes.at(-1)?.n).sort();
      expect(passNumbers).toEqual([1, 2]);
      const minted = outputs.flatMap((output) => output.passes.at(-1)?.ideas ?? []);
      expect(minted.map((idea) => idea.id).sort()).toEqual(['i-1', 'i-2', 'i-3', 'i-4']);
      // The later pass sees the earlier one, so its own view of the session holds both.
      const later = outputs.find((output) => output.passes.length === 2);
      expect(later?.raw).toEqual(['i-1', 'i-2', 'i-3', 'i-4']);

      // The proof that nothing collided: a log with a duplicate id or a pass out of sequence
      // cannot be read back at all, so a session that still rebuilds is a session that survived.
      const store = ModeSessionStore.open(root);
      const state = readIdeationSession(await store.read('ideation', SESSION));
      expect(state.passes.map((pass) => pass.n)).toEqual([1, 2]);
      expect(state.ideas.map((idea) => idea.id)).toEqual(['i-1', 'i-2', 'i-3', 'i-4']);
      expect(state.nextIdeaNumber).toBe(5);
      const lines = (await Bun.file(store.absolutePath('ideation', SESSION)).text())
        .trimEnd()
        .split('\n');
      expect(lines.map((line) => JSON.parse(line).kind)).toEqual([
        'pass',
        'cluster',
        'pass',
        'cluster',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('two concurrent expansion passes continue one numbering rather than overlapping', async () => {
    const root = await temporaryRoot();
    try {
      await ideation.handle(
        build({
          root,
          sessionId: SESSION,
          motion: 'Ways to make advisor notes visible',
          families: ['xai'],
          flags: { seats: ['2'], 'ideas-per-seat': ['1'] },
        }).input,
      );
      const call = () =>
        ideation.handle(
          build({
            root,
            sessionId: SESSION,
            families: ['xai'],
            flags: { seats: ['2'], 'ideas-per-seat': ['1'], expand: ['k-1'] },
            reply: (lens) => JSON.stringify({ ideas: [{ text: `${lens} expanded note` }] }),
          }).input,
        );
      const outcomes = await Promise.all([call(), call()]);
      const outputs = outcomes.map((outcome) => {
        if (outcome.kind !== 'result') throw new Error('unreachable');
        return IdeationOutputSchema.parse(outcome.output);
      });
      expect(outputs.map((output) => output.passes.at(-1)?.n).sort()).toEqual([2, 3]);
      const minted = outputs.flatMap((output) => output.passes.at(-1)?.ideas ?? []);
      expect(minted.map((idea) => idea.id).sort()).toEqual(['i-3', 'i-4', 'i-5', 'i-6']);
      for (const output of outputs) {
        expect(output.passes.at(-1)?.scope).toEqual(['k-1']);
      }

      const store = ModeSessionStore.open(root);
      const state = readIdeationSession(await store.read('ideation', SESSION));
      expect(state.passes.map((pass) => pass.n)).toEqual([1, 2, 3]);
      expect(state.ideas.map((idea) => idea.id)).toEqual([
        'i-1',
        'i-2',
        'i-3',
        'i-4',
        'i-5',
        'i-6',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a pass the log refuses writes neither of its two lines', async () => {
    const root = await temporaryRoot();
    try {
      // Both calls open the same new session, so both find no log and both believe they are pass
      // one; only inside the write lock does the loser learn the session already has a prompt.
      const call = (motion: string) =>
        ideation.handle(
          build({
            root,
            sessionId: SESSION,
            motion,
            families: ['xai'],
            flags: { seats: ['1'], 'ideas-per-seat': ['1'] },
          }).input,
        );
      const settled = await Promise.allSettled([
        call('The first question'),
        call('A different question'),
      ]);
      const kept = settled.filter((result) => result.status === 'fulfilled');
      const refused = settled.filter((result) => result.status === 'rejected');
      expect([kept.length, refused.length]).toEqual([1, 1]);
      expect(String(refused[0]?.status === 'rejected' ? refused[0].reason : '')).toContain(
        'different prompt',
      );

      // The refusal happens before either line is written, so the winner's session is whole and
      // the loser left nothing behind: no pass without its clustering, and no second prompt.
      const store = ModeSessionStore.open(root);
      const text = await Bun.file(store.absolutePath('ideation', SESSION)).text();
      const lines = text.trimEnd().split('\n');
      expect(lines).toHaveLength(2);
      const state = readIdeationSession(await store.read('ideation', SESSION));
      expect(state.passes).toHaveLength(1);
      expect(state.ideas).toHaveLength(1);
      const survivor = kept[0]?.status === 'fulfilled' ? kept[0].value : null;
      if (survivor === null || survivor.kind !== 'result') throw new Error('unreachable');
      expect(state.prompt).toBe(IdeationOutputSchema.parse(survivor.output).prompt);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
