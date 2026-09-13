import { z } from 'zod';
import {
  CouncilOutcomeSchema,
  ProviderFamilySchema,
  QuorumEvaluationSchema,
} from '../../substrate';
import type { ModeDefinition } from '../types';

const NonEmptyStringSchema = z.string().trim().min(1);

export const SecondOpinionOutputSchema = z.strictObject({
  outcome: CouncilOutcomeSchema,
  quorum: QuorumEvaluationSchema,
  panel: z.array(
    z.strictObject({
      seat: NonEmptyStringSchema,
      family: ProviderFamilySchema,
      lens: NonEmptyStringSchema,
      answer: z.string(),
    }),
  ),
});

export const secondOpinion: ModeDefinition = {
  name: 'second-opinion',
  knobs: {
    participants: 'three or more distinct families, blind, one lens each',
    pattern: 'parallel',
    aggregation: 'attributed panel; synthesis is a later brief',
    tempo: 'about a minute',
    records: 'session with every seat answer',
  },
  pattern: 'parallel',
  defaults: { impact: 'medium', contested: false, rounds: 1 },
  spend: { policy: 'capped', defaultCap: (seats, rounds) => seats * rounds },
  outputSchema: SecondOpinionOutputSchema,
  async prepare({ options }) {
    return { kind: 'ready', options, unavailableProviders: [] };
  },
  output({ result }) {
    const first = result.rounds[0];
    const panel =
      first === undefined
        ? []
        : first.responses.flatMap((response) =>
            response.status === 'ok'
              ? [
                  {
                    seat: response.seatId,
                    family: response.provider,
                    lens: response.role,
                    answer: response.answer,
                  },
                ]
              : [],
          );
    return { outcome: result.outcome, quorum: result.quorum, panel };
  },
};
