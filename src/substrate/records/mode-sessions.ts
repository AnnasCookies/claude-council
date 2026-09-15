import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { scopeDirectory, withScopeWriteLock, writeTextAtomically, type RecordWrite } from './store';

const TimestampSchema = z.string().datetime({ offset: true });
const ProjectIdSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/, 'must be a safe storage identifier');

export const ModeSessionPrefixSchema = z
  .string()
  .regex(/^[a-z]{1,8}$/, 'A session prefix is one to eight lower-case letters');
export const ModeSessionIdSchema = z
  .string()
  .regex(
    /^[a-z]{1,8}-\d{4}-\d{2}-\d{2}-[a-f0-9]{6}$/,
    'A session id is <prefix>-<yyyy-mm-dd>-<six hex characters>',
  );
export const ModeSessionModeSchema = z
  .string()
  .regex(/^[a-z][a-z-]{0,31}$/, 'A mode name is lower-case letters and hyphens');

/**
 * The mode's own payload, kept opaque so a corrupt or foreign line is refused on structure alone
 * rather than on a mode's semantics. Opaque is not anything: `undefined` does not survive
 * `JSON.stringify`, so it used to be accepted here and then fail the store's own read-back of the
 * line it had just written, blaming the file for the caller's value. It is refused on the way in
 * instead, where the message can say what to pass instead. Declared as `ZodType<unknown>` so a
 * mode may still hand over a value it holds only as `unknown`; this check is what rules out the
 * one value that cannot round-trip.
 */
const ModeSessionDataSchema: z.ZodType<unknown> = z
  .unknown()
  .refine(
    (value) => value !== undefined,
    'A mode session event needs JSON-serialisable data; pass null for an event that carries none',
  );

/**
 * One line of a session log. `data` is the mode's own shape; the store keeps it opaque so a
 * corrupt or foreign line is refused on structure alone, not on a mode's semantics.
 */
export const ModeSessionEventSchema = z.strictObject({
  at: TimestampSchema,
  kind: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, 'An event kind is a lower-case slug'),
  data: ModeSessionDataSchema,
});
export type ModeSessionEvent = z.infer<typeof ModeSessionEventSchema>;

const ModeSessionScopeSchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('general') }),
  z.strictObject({ scope: z.literal('project'), projectId: ProjectIdSchema }),
]);
export type ModeSessionScope = z.infer<typeof ModeSessionScopeSchema>;

/**
 * A harness's own session identity: Claude Code's `session_id`, omp's session id, a codex thread
 * id. It is opaque to the store, so the only rules are that it fits a JSON object key and cannot
 * carry a control character into the index file.
 */
export const ModeSessionKeySchema = z
  .string()
  .min(1)
  .max(256)
  .refine((key) => !/[\p{Cc}\p{Cf}]/u.test(key), 'A session key has no control characters');

/**
 * The alias map is validated as entries rather than with `z.record`, because `z.record` builds
 * its output object by assignment: a key named `__proto__` is swallowed by the prototype setter
 * instead of becoming an own property, so an index that had stored one could never read it back
 * and every call would mint a fresh id for the same harness session. `Object.fromEntries`
 * defines each key, so the index round-trips whatever a harness used as its session key.
 */
const ModeSessionAliasesSchema = z
  .preprocess(
    (value) => (typeof value === 'object' && value !== null ? Object.entries(value) : value),
    z.array(z.tuple([ModeSessionKeySchema, ModeSessionIdSchema])),
  )
  .transform((entries) => Object.fromEntries(entries));

const ModeSessionAliasIndexSchema = z.strictObject({
  schemaVersion: z.literal(1),
  aliases: ModeSessionAliasesSchema,
});
type ModeSessionAliasIndex = z.infer<typeof ModeSessionAliasIndexSchema>;

/**
 * Read one alias, never the prototype. A bare `index.aliases[key]` answers a key the index does
 * not hold — `constructor`, `toString`, `__proto__` — from `Object.prototype`, handing the caller
 * a function or an object where the signature promises a session id.
 */
function ownAlias(aliases: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(aliases, key) ? aliases[key] : undefined;
}

export interface ModeSessionAlias {
  readonly sessionId: string;
  /** True when this call minted the id; false when the key was already bound. */
  readonly created: boolean;
}

export function newModeSessionId(prefix: string, now: string = new Date().toISOString()): string {
  const safePrefix = ModeSessionPrefixSchema.parse(prefix);
  const day = TimestampSchema.parse(now).slice(0, 10);
  return ModeSessionIdSchema.parse(`${safePrefix}-${day}-${randomBytes(3).toString('hex')}`);
}

function parseEvents(text: string, path: string): ModeSessionEvent[] {
  if (text.length === 0) return [];
  if (!text.endsWith('\n')) {
    throw new Error(`Torn mode session log (no trailing newline): ${path}`);
  }
  return text
    .slice(0, -1)
    .split('\n')
    .map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid mode session event JSON at line ${index + 1}: ${path}`, {
          cause: error,
        });
      }
      const parsed = ModeSessionEventSchema.safeParse(value);
      if (!parsed.success) {
        throw new Error(`Invalid mode session event at line ${index + 1}: ${path}`, {
          cause: parsed.error,
        });
      }
      return parsed.data;
    });
}

/**
 * An append-only JSONL log per mode session under the records root. A session id is validated
 * against a strict pattern before it is joined into any path, and every line is validated on
 * the way in and on the way out.
 */
export class ModeSessionStore {
  readonly root: string;
  private readonly scope: ModeSessionScope;

  private constructor(root: string, scope: ModeSessionScope) {
    this.root = root;
    this.scope = scope;
  }

  static open(root: string, scope: ModeSessionScope = { scope: 'general' }): ModeSessionStore {
    return new ModeSessionStore(
      resolve(z.string().trim().min(1).parse(root)),
      ModeSessionScopeSchema.parse(scope),
    );
  }

  newSessionId(prefix: string, now?: string): string {
    return newModeSessionId(prefix, now);
  }

  private directory(mode: string): string {
    const safeMode = ModeSessionModeSchema.parse(mode);
    const scoped =
      this.scope.scope === 'general'
        ? scopeDirectory(this.root, 'general')
        : scopeDirectory(this.root, 'project', this.scope.projectId);
    return join(scoped, 'modes', safeMode);
  }

  absolutePath(mode: string, sessionId: string): string {
    return join(this.directory(mode), `${ModeSessionIdSchema.parse(sessionId)}.jsonl`);
  }

  /** Records-root-relative, forward-slash form for the envelope, like `sessionRecordPath`. */
  recordPath(mode: string, sessionId: string): string {
    const safeMode = ModeSessionModeSchema.parse(mode);
    const safeId = ModeSessionIdSchema.parse(sessionId);
    const scopePart =
      this.scope.scope === 'general' ? 'general' : `projects/${this.scope.projectId}`;
    return `${scopePart}/modes/${safeMode}/${safeId}.jsonl`;
  }

  /** The per-mode alias index, harness session key to store session id, beside the logs. */
  aliasPath(mode: string): string {
    return join(this.directory(mode), 'index.json');
  }

  private async readAliasIndex(path: string): Promise<ModeSessionAliasIndex> {
    const file = Bun.file(path);
    if (!(await file.exists())) return { schemaVersion: 1, aliases: {} };
    let value: unknown;
    try {
      value = JSON.parse(await file.text());
    } catch (error) {
      throw new Error(`Invalid mode session alias index JSON: ${path}`, { cause: error });
    }
    return ModeSessionAliasIndexSchema.parse(value);
  }

  async lookupAlias(mode: string, key: string): Promise<string | undefined> {
    const safeKey = ModeSessionKeySchema.parse(key);
    const index = await this.readAliasIndex(this.aliasPath(mode));
    return ownAlias(index.aliases, safeKey);
  }

  /**
   * Bind a harness session key to a store session id, minting one on first use. The whole
   * read-mint-write runs under the scope lock so two hooks firing for the same new session
   * cannot each mint an id and split one session's notes across two logs. A corrupt index is
   * refused rather than replaced: it may be the only map from live sessions to their logs.
   */
  async bindAlias(
    mode: string,
    key: string,
    prefix: string,
    now?: string,
  ): Promise<ModeSessionAlias> {
    const safeKey = ModeSessionKeySchema.parse(key);
    const path = this.aliasPath(mode);
    return withScopeWriteLock(dirname(path), async () => {
      const index = await this.readAliasIndex(path);
      const existing = ownAlias(index.aliases, safeKey);
      if (existing !== undefined) return { sessionId: existing, created: false };
      const sessionId = newModeSessionId(prefix, now);
      const next: ModeSessionAliasIndex = {
        schemaVersion: 1,
        aliases: { ...index.aliases, [safeKey]: sessionId },
      };
      await writeTextAtomically(path, `${JSON.stringify(next, null, 2)}\n`, {
        replace: true,
        validate: (text) => {
          ModeSessionAliasIndexSchema.parse(JSON.parse(text));
        },
      });
      return { sessionId, created: true };
    });
  }

  async exists(mode: string, sessionId: string): Promise<boolean> {
    return Bun.file(this.absolutePath(mode, sessionId)).exists();
  }

  async read(mode: string, sessionId: string): Promise<ModeSessionEvent[]> {
    const path = this.absolutePath(mode, sessionId);
    const file = Bun.file(path);
    if (!(await file.exists())) {
      throw new Error(`Unknown mode session: ${this.recordPath(mode, sessionId)}`);
    }
    return parseEvents(await file.text(), path);
  }

  async append(mode: string, sessionId: string, event: ModeSessionEvent): Promise<RecordWrite> {
    // Validated here rather than only inside the lock so a malformed event is refused before the
    // scope directory is created for it.
    const record = ModeSessionEventSchema.parse(event);
    return this.appendDerived(mode, sessionId, () => record);
  }

  /**
   * Append what the caller derives from the log as it stands, with the read, the derivation and
   * the write all under one scope lock.
   *
   * `append` cannot give that guarantee: a caller that reads the log, decides something from it
   * and then appends leaves a window between the two in which another call can append, so two
   * overlapping callers each decide from the same stale log — two advisor notes both minted
   * `n-1`, or two `--end` calls each reporting that they closed the session. `derive` runs inside
   * the lock instead, and is deliberately synchronous: anything slow (consulting a seat) belongs
   * outside it, leaving only the part of the decision that reads the log in here. Returning
   * `null` appends nothing and reports no path, which is how a caller says the log already
   * settled the question.
   *
   * A derivation may return several events, and they are published in one rewrite. A mode whose
   * step is two lines — ideation's pass and the clustering over it — would otherwise have to
   * append twice, and a concurrent call taking the lock between the two reads a log in which the
   * pass has landed and its clustering has not. Throwing from `derive` writes nothing at all,
   * which is how a caller refuses a step the log it has just read turns out to forbid.
   */
  async appendDerived(
    mode: string,
    sessionId: string,
    derive: (
      events: readonly ModeSessionEvent[],
    ) => ModeSessionEvent | readonly ModeSessionEvent[] | null,
  ): Promise<RecordWrite> {
    const path = this.absolutePath(mode, sessionId);
    return withScopeWriteLock(dirname(path), async () => {
      const file = Bun.file(path);
      const existing = (await file.exists()) ? await file.text() : '';
      // A log that cannot be read back is not extended: appending to it would bury the corruption
      // under valid lines and make the whole session unreadable later.
      const events = parseEvents(existing, path);
      const derived = derive(events);
      if (derived === null) return { paths: [] };
      const records = (isEventList(derived) ? derived : [derived]).map((event) =>
        ModeSessionEventSchema.parse(event),
      );
      // An empty list is the same statement as `null`: the log already settled the question.
      if (records.length === 0) return { paths: [] };
      // Rewrite-and-rename rather than appendFile: a crash midway through an append leaves a torn
      // last line that fails every later read, whereas the rename publishes the complete new log
      // or leaves the old one untouched. The lock keeps two appends from racing the rewrite.
      const content = `${existing}${records.map((record) => `${JSON.stringify(record)}\n`).join('')}`;
      await writeTextAtomically(path, content, {
        replace: true,
        validate: (text) => {
          parseEvents(text, path);
        },
      });
      return { paths: [path] };
    });
  }
}

/**
 * A predicate rather than a bare `Array.isArray`, so the list branch stays typed as a list of
 * events instead of widening to `any[]` on the way through.
 */
function isEventList(
  derived: ModeSessionEvent | readonly ModeSessionEvent[],
): derived is readonly ModeSessionEvent[] {
  return Array.isArray(derived);
}
