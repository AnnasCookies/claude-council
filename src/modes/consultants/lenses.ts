import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { PanelLensSchema, roleCatalogue, type PanelLens } from '../../substrate';

/**
 * A seat per lens, so a room larger than the catalogue is a different mode: `ideate` is the room
 * for many cheap voices. The bound also bounds the session's default spend cap, which is two
 * metered calls per seat.
 */
export const MAX_CONSULTANTS = 12;

/**
 * The governed catalogue as panel lenses. A catalogue name a panel lens name cannot carry is left
 * out rather than rewritten: a seat id is `family/model#lens`, and a name holding a space or an
 * apostrophe would produce an id nothing can read back. Today that is `devil's advocate` alone,
 * and `critic` carries the same contrarian brief.
 */
export function catalogueLenses(): PanelLens[] {
  return roleCatalogue.flatMap((lens) => {
    const parsed = PanelLensSchema.safeParse({ name: lens.name, description: lens.prompt });
    return parsed.success ? [parsed.data] : [];
  });
}

export const ConsultantPersonasSchema = z
  .array(PanelLensSchema)
  .min(1)
  .max(MAX_CONSULTANTS)
  .superRefine((personas, context) => {
    const seen = new Set<string>();
    for (const [index, persona] of personas.entries()) {
      if (seen.has(persona.name)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'name'],
          message: `Duplicate persona: ${persona.name}`,
        });
      }
      seen.add(persona.name);
    }
  });

export async function loadPersonas(path: string, cwd: string): Promise<PanelLens[]> {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  let value: unknown;
  try {
    value = await Bun.file(absolute).json();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to read --personas ${path}: ${reason}. It must be a JSON array of { "name", "description" }.`,
    );
  }
  return ConsultantPersonasSchema.parse(value);
}

/** `--lens security,privacy --lens maintainer` is three lenses, in the order they were named. */
export function parseLensNames(values: readonly string[]): string[] {
  const names = values
    .flatMap((value) => value.split(','))
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) throw new Error('consult needs at least one --lens <name>');
  if (names.length > MAX_CONSULTANTS) {
    throw new Error(`consult seats at most ${MAX_CONSULTANTS} consultants; ${names.length} named`);
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`Duplicate lens: ${name}`);
    seen.add(name);
  }
  return names;
}

export function resolveLenses(
  names: readonly string[],
  personas: readonly PanelLens[],
): PanelLens[] {
  const supplied = new Map(personas.map((persona) => [persona.name, persona]));
  const catalogue = new Map(catalogueLenses().map((lens) => [lens.name, lens]));
  return names.map((name) => {
    // A supplied persona wins: the caller wrote it for this brief, and the catalogue entry of the
    // same name is the general-purpose version of the same idea.
    const lens = supplied.get(name) ?? catalogue.get(name);
    if (lens === undefined) {
      throw new Error(
        `Unknown lens: ${name}. Catalogue lenses: ${[...catalogue.keys()].join(', ')}. Supply any other lens with --personas <file>, a JSON array of { "name", "description" }.`,
      );
    }
    return lens;
  });
}
