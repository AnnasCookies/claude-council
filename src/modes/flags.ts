/**
 * The flag readers a handler mode needs over `HandlerInput.flags`, in one place.
 *
 * Not a mode, and it holds no mode's knowledge: it takes the parsed flag map rather than a
 * `HandlerInput`, so a mode may import it without importing another mode. The CLI and the advisor
 * still carry their own copies of the first two, because they read from their own argument shapes
 * and other branches build on those; this is the home the next mode should reach for.
 */

/** The parsed flags a handler mode is handed: the flag name without its dashes, to its values. */
export type ModeFlags = ReadonlyMap<string, readonly string[]>;

/** The single value of a flag that may appear at most once, or `undefined` when it is absent. */
export function oneValue(flags: ModeFlags, name: string): string | undefined {
  const values = flags.get(name);
  if (values === undefined) return undefined;
  if (values.length !== 1) throw new Error(`Option --${name} may be provided only once`);
  return values[0];
}

/** A bounded integer flag. An absent flag takes the fallback; anything outside the range fails. */
export function integerValue(
  flags: ModeFlags,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = oneValue(flags, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Option --${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

/**
 * A comma-separated list flag, trimmed and emptied of blanks. A flag that was given but holds no
 * value at all is a usage error rather than an empty list, because the caller meant to name
 * something.
 */
export function listValue(flags: ModeFlags, name: string): string[] | undefined {
  const raw = oneValue(flags, name);
  if (raw === undefined) return undefined;
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length === 0) throw new Error(`Option --${name} needs at least one value`);
  return items;
}
