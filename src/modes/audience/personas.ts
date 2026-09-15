import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { PanelLensSchema, type PanelLens } from '../../substrate';

/**
 * One seat per persona, so the persona list is also the seat count. Twenty-four voices is already
 * a crowd for one draft; past that an audience is a batch job and belongs in triage.
 */
export const MAX_PERSONAS = 24;

/** A persona file is a hand-written cast list, not a corpus: enough for the entries and briefs. */
const MAX_PERSONA_FILE_BYTES = 64 * 1024;

const PersonaListSchema = z
  .array(PanelLensSchema)
  .min(1, 'At least one persona is required')
  .max(MAX_PERSONAS, `At most ${MAX_PERSONAS} personas are allowed`)
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

/** Used when `--personas` names a reader without describing one: the name is the whole brief. */
export function defaultPersonaDescription(name: string): string {
  return `You are the "${name}" reader of this draft. React as that reader would, in that reader's voice.`;
}

/**
 * `--personas` is a comma list of `name` or `name:description`. A persona name can hold neither a
 * comma nor a colon — `PanelLensSchema` allows letters, digits, dot, underscore and hyphen only —
 * so both splits are unambiguous. A description that needs a comma belongs in `--personas-file`.
 */
export function parsePersonaList(value: string): PanelLens[] {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) throw new Error('--personas needs at least one persona name');
  return PersonaListSchema.parse(
    entries.map((entry) => {
      const separator = entry.indexOf(':');
      const name = (separator === -1 ? entry : entry.slice(0, separator)).trim();
      const description = separator === -1 ? '' : entry.slice(separator + 1).trim();
      return {
        name,
        description: description.length === 0 ? defaultPersonaDescription(name) : description,
      };
    }),
  );
}

/** `--personas-file` is a JSON array of `{ name, description }`: both fields, on every entry. */
export function parsePersonaFile(text: string): PanelLens[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('--personas-file must contain a JSON array of { name, description } entries');
  }
  return PersonaListSchema.parse(value);
}

export async function readPersonaFile(path: string, cwd: string): Promise<PanelLens[]> {
  const given = path.trim();
  if (given.length === 0) throw new Error('--personas-file needs a path');
  const absolute = isAbsolute(given) ? resolve(given) : resolve(cwd, given);
  const stats = await stat(absolute).catch(() => null);
  if (stats === null) throw new Error(`No persona file found at ${given}`);
  if (!stats.isFile()) throw new Error(`The persona file at ${given} is not a file`);
  if (stats.size > MAX_PERSONA_FILE_BYTES) {
    throw new Error(
      `The persona file at ${given} is ${stats.size} bytes; the limit is ${MAX_PERSONA_FILE_BYTES} bytes`,
    );
  }
  return parsePersonaFile(await readFile(absolute, 'utf8'));
}
