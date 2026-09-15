import { z } from 'zod';

/**
 * One term in a declared schema. Terms are lower-case slugs because they are compared exactly,
 * printed into the prompt and branched on by the calling agent: a schema whose classes differ only
 * in case would route two ways for one meaning.
 */
const TriageTermSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, 'must be 1 to 32 lower-case letters, digits or hyphens');

function distinctTerms(label: string) {
  return z
    .array(TriageTermSchema)
    .min(1, `${label} must list at least one term`)
    .superRefine((terms, context) => {
      const seen = new Set<string>();
      for (const [index, term] of terms.entries()) {
        if (seen.has(term)) {
          context.addIssue({
            code: 'custom',
            path: [index],
            message: `Duplicate ${label} term: ${term}`,
          });
        }
        seen.add(term);
      }
    });
}

/** Where an item goes when the desk cannot sort it with one voice. */
export const HUMAN_ROUTE = 'human';

export const TriageSchemaSchema = z.strictObject({
  name: TriageTermSchema,
  classes: distinctTerms('classes'),
  severities: distinctTerms('severities'),
  routes: distinctTerms('routes'),
});
export type TriageSchema = z.infer<typeof TriageSchemaSchema>;

/**
 * `human` is the route a disagreement takes, so every declared schema has to be able to express
 * it. A schema that omits it gets it appended rather than being refused, and a schema that
 * declares it keeps its own ordering: the caller's route order is what its pipeline reads.
 */
export function parseTriageSchema(value: unknown): TriageSchema {
  const declared = TriageSchemaSchema.parse(value);
  if (declared.routes.includes(HUMAN_ROUTE)) return declared;
  return { ...declared, routes: [...declared.routes, HUMAN_ROUTE] };
}

const PR_COMMENT_SOURCE = {
  name: 'pr-comment',
  classes: ['bug', 'style', 'question', 'nit', 'praise', 'security'],
  severities: ['low', 'medium', 'high'],
  routes: ['fix', 'discuss', 'ignore', 'human'],
} as const;

export const BUILT_IN_TRIAGE_SCHEMA_NAMES = ['pr-comment'] as const;

/**
 * A fresh copy per call. The returned lists are ordinary arrays that the prompt builder and the
 * JSON schema both read, and a shared instance would let one batch's mutation reach the next.
 */
export function builtInTriageSchema(name: string): TriageSchema {
  if (name !== 'pr-comment') {
    throw new Error(
      `Unknown triage schema: ${name}. Built-in schemas: ${BUILT_IN_TRIAGE_SCHEMA_NAMES.join(', ')}. Declare your own with --schema-file <path>.`,
    );
  }
  return parseTriageSchema(PR_COMMENT_SOURCE);
}

export async function loadTriageSchemaFile(path: string): Promise<TriageSchema> {
  let value: unknown;
  try {
    value = await Bun.file(path).json();
  } catch (error) {
    throw new Error(
      `Unable to read triage schema file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseTriageSchema(value);
}

/** One seat's verdict on one item, before the mode attributes it to a seat. */
export interface TriageVerdictFields {
  readonly class: string;
  readonly severity: string;
  readonly route: string;
  readonly confidence: number;
  readonly reason: string;
}

/**
 * Membership is a refinement rather than `z.enum` because the terms arrive at runtime from the
 * declared schema. The refinement names the allowed terms in its message, and that message is
 * what a discarded verdict carries into the record, so the log says which term was invented.
 */
function memberOf(terms: readonly string[], label: string): z.ZodType<string> {
  const allowed = new Set(terms);
  return z.string().refine((value) => allowed.has(value), {
    message: `${label} must be one of: ${terms.join(', ')}`,
  });
}

/** The schema every seat answer is validated against. A miss is discarded, never coerced. */
export function triageVerdictSchema(schema: TriageSchema): z.ZodType<TriageVerdictFields> {
  return z.strictObject({
    class: memberOf(schema.classes, 'class'),
    severity: memberOf(schema.severities, 'severity'),
    route: memberOf(schema.routes, 'route'),
    confidence: z.number().min(0).max(1),
    reason: z.string().trim().min(1).max(400),
  });
}

/** Handed to the transports that constrain decoding, beside the instruction below. */
export function triageAnswerJsonSchema(schema: TriageSchema): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['class', 'severity', 'route', 'confidence', 'reason'],
    properties: {
      class: { type: 'string', enum: [...schema.classes] },
      severity: { type: 'string', enum: [...schema.severities] },
      route: { type: 'string', enum: [...schema.routes] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string', minLength: 1, maxLength: 400 },
    },
  };
}

export function triageAnswerInstruction(schema: TriageSchema): string {
  return [
    'Return exactly one JSON object with these keys:',
    `class (one of: ${schema.classes.join(', ')}),`,
    `severity (one of: ${schema.severities.join(', ')}),`,
    `route (one of: ${schema.routes.join(', ')}),`,
    'confidence (number from 0 to 1),',
    'reason (one short sentence).',
    `Choose ${HUMAN_ROUTE} when the item cannot be sorted from its text alone.`,
    'Do not wrap it in prose.',
  ].join(' ');
}
