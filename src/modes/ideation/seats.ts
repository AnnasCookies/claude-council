import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import {
  ModelRegistrySchema,
  PanelLensSchema,
  ProviderFamilySchema,
  roleCatalogue,
  spreadSeats,
  type ModelRegistry,
  type ModelRoute,
  type PanelLens,
  type PanelSeatSpec,
  type ProviderFamily,
} from '../../substrate';

/**
 * Deliberately narrower than the panel's own lens-name rule, so a slug produced here is always a
 * name the panel will accept.
 */
const LensNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'A lens name is lower-case letters, digits and hyphens');

/**
 * Apostrophes are removed rather than broken on, so the catalogue's "devil's advocate" becomes
 * `devils-advocate` instead of `devil-s-advocate`. The name is untrusted when it comes from a
 * persona file, so it is echoed back trimmed and bounded.
 */
export function lensSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const parsed = LensNameSchema.safeParse(slug);
  if (!parsed.success) {
    throw new Error(
      `A lens or persona name must contain letters or digits; received "${name.slice(0, 40)}"`,
    );
  }
  return parsed.data;
}

/** The governed catalogue as panel lenses: its name slugged, its brief as the lens description. */
export const CATALOGUE_LENSES: readonly PanelLens[] = Object.freeze(
  roleCatalogue.map((lens) =>
    Object.freeze(PanelLensSchema.parse({ name: lensSlug(lens.name), description: lens.prompt })),
  ),
);

export function catalogueLens(name: string): PanelLens {
  const slug = lensSlug(name);
  const lens = CATALOGUE_LENSES.find((candidate) => candidate.name === slug);
  if (lens === undefined) {
    throw new Error(
      `Unknown lens: ${name.slice(0, 40)}. The catalogue holds ${CATALOGUE_LENSES.map((candidate) => candidate.name).join(', ')}.`,
    );
  }
  return lens;
}

export const PersonaFileSchema = z
  .array(
    z.strictObject({
      name: z.string().trim().min(1).max(64),
      description: z.string().trim().min(1).max(2_000),
    }),
  )
  .min(1)
  .max(64);

function assertDistinct(lenses: readonly PanelLens[]): readonly PanelLens[] {
  const seen = new Set<string>();
  for (const lens of lenses) {
    if (seen.has(lens.name)) throw new Error(`Duplicate lens name: ${lens.name}`);
    seen.add(lens.name);
  }
  return lenses;
}

/**
 * A persona list is supplied with the call, so it is read as data: validated against a strict
 * schema, slugged into lens names, and checked for duplicates before any of it reaches a prompt.
 * The handler passes its descriptions through the outbound policy guard as well.
 */
export async function loadPersonaLenses(path: string, cwd: string): Promise<PanelLens[]> {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  let value: unknown;
  try {
    value = await Bun.file(absolute).json();
  } catch (error) {
    throw new Error(`Unable to read the persona list: ${absolute}`, { cause: error });
  }
  const lenses = PersonaFileSchema.parse(value).map((persona) =>
    PanelLensSchema.parse({ name: lensSlug(persona.name), description: persona.description }),
  );
  assertDistinct(lenses);
  return lenses;
}

/**
 * One seat per lens, the pool cycled when the room is larger than the pool. The k-th time round a
 * lens is named `<lens>-<k>`, because the panel needs distinct seat ids and a reader of the record
 * needs to know which of the three strategists said a thing.
 *
 * A named list is a request for those lenses exactly, so a room smaller than the list is a
 * contradiction and fails; the catalogue is only the default pool, so a small room simply takes
 * the first few of it.
 *
 * The seated list is checked for duplicates as well as the pool, because the cycle suffix is added
 * after the pool was checked and can collide with a pool name that already looks like one: personas
 * "Security" and "Security 2" slug to `security` and `security-2`, and the second time round the
 * pool `security` is seated as `security-2` too. The panel would only catch that when both landed
 * on the same family, since a seat id carries the family and the model; with the seats spread over
 * two families it would seat two lenses with one name and say nothing. It is a usage error at every
 * family count, so it is raised here.
 */
export function resolveSeatLenses(input: {
  readonly seats: number;
  readonly named: readonly PanelLens[] | null;
}): PanelLens[] {
  const seats = z.number().int().min(1).parse(input.seats);
  if (input.named !== null && seats < input.named.length) {
    throw new Error(`--seats ${seats} is fewer than the ${input.named.length} lenses named`);
  }
  const pool = assertDistinct(input.named ?? CATALOGUE_LENSES.slice(0, seats));
  const seated = Array.from({ length: seats }, (_, index) => {
    const base = pool[index % pool.length];
    if (base === undefined) throw new Error('A room needs at least one lens');
    const cycle = Math.floor(index / pool.length) + 1;
    return cycle === 1
      ? base
      : PanelLensSchema.parse({ name: `${base.name}-${cycle}`, description: base.description });
  });
  assertDistinct(seated);
  return seated;
}

export function parseModelOverrides(value: string | undefined): Map<ProviderFamily, string> {
  const overrides = new Map<ProviderFamily, string>();
  if (value === undefined) return overrides;
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      throw new Error(
        `Option --models takes <family>=<model> pairs; received "${entry.slice(0, 40)}"`,
      );
    }
    const family = ProviderFamilySchema.parse(entry.slice(0, separator).trim());
    const model = z
      .string()
      .trim()
      .min(1)
      .max(128)
      .parse(entry.slice(separator + 1));
    if (overrides.has(family)) throw new Error(`Option --models names ${family} twice`);
    overrides.set(family, model);
  }
  return overrides;
}

/**
 * Cheap seats by default, by the only rule the registry supports. A route records a primary, a
 * list of same-family fallbacks and a transport — there is no cost field and no tier field — so
 * the cheap model is the family's first fallback where it lists one (in the shipped registry those
 * are the smaller or older sibling: `gemini-3.6-flash-high`, `deepseek-v4-flash`, `grok-4.5`) and
 * the primary otherwise, because a family with no listed fallback offers nothing else. `--models
 * <family>=<model>` overrides it.
 *
 * The chosen model is then what identity verification must match, so the dearer primary is dropped
 * from the fallbacks: leaving it there would let a provider serve it, report `ok`, and quietly
 * spend the money this mode exists to avoid.
 */
function ideationRoute(route: ModelRoute, override: string | undefined): ModelRoute {
  const model = override ?? route.fallbacks[0] ?? route.primary;
  return {
    ...route,
    primary: model,
    fallbacks: route.fallbacks.filter((candidate) => candidate !== model),
  };
}

export function ideationRegistry(
  registry: ModelRegistry,
  overrides: ReadonlyMap<ProviderFamily, string>,
): ModelRegistry {
  return ModelRegistrySchema.parse({
    anthropic: ideationRoute(registry.anthropic, overrides.get('anthropic')),
    openai: ideationRoute(registry.openai, overrides.get('openai')),
    xai: ideationRoute(registry.xai, overrides.get('xai')),
    google: ideationRoute(registry.google, overrides.get('google')),
    deepseek: ideationRoute(registry.deepseek, overrides.get('deepseek')),
    moonshot: ideationRoute(registry.moonshot, overrides.get('moonshot')),
  });
}

/**
 * The seat roster. `spreadSeats` reads each family's `primary`, which is why the registry handed in
 * here is the derived one: the model on the seat spec is then the model the adapter will request
 * and the identity it will verify, with nothing to reconcile afterwards.
 */
export function ideationSeats(input: {
  readonly families: readonly ProviderFamily[];
  readonly lenses: readonly PanelLens[];
  readonly registry: ModelRegistry;
}): PanelSeatSpec[] {
  return spreadSeats(input.families, input.lenses, input.registry);
}
