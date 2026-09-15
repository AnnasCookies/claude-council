import { z } from 'zod';

/** The two boolean fields a reaction is counted on. `stoppedAt` is prose and is never counted. */
export interface AudienceCountableFields {
  readonly clear: boolean;
  readonly wouldAct: boolean;
}

const CountSchema = z.number().int().nonnegative();

export const AudienceTalliesSchema = z.strictObject({
  answered: CountSchema,
  clear: z.strictObject({ yes: CountSchema, no: CountSchema }),
  wouldAct: z.strictObject({ yes: CountSchema, no: CountSchema }),
});
export type AudienceTallies = z.infer<typeof AudienceTalliesSchema>;

/**
 * Counting, and nothing else: no percentage, no average, no score. `answered` is how many voices
 * answered, and each pair counts the two ways one boolean came back, so `yes + no === answered`
 * holds for every run and a reader can check the arithmetic against the reactions beside it.
 */
export function tallyReactions(reactions: readonly AudienceCountableFields[]): AudienceTallies {
  return AudienceTalliesSchema.parse({
    answered: reactions.length,
    clear: {
      yes: reactions.filter((reaction) => reaction.clear).length,
      no: reactions.filter((reaction) => !reaction.clear).length,
    },
    wouldAct: {
      yes: reactions.filter((reaction) => reaction.wouldAct).length,
      no: reactions.filter((reaction) => !reaction.wouldAct).length,
    },
  });
}
