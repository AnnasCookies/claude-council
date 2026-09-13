import { z } from 'zod';
import {
  CouncilOutcomeSchema,
  DEFAULT_COUNCIL_MINIMUM_FAMILIES,
  PersistedDecisionStateSchema,
  QuorumEvaluationSchema,
  REDUCED_COUNCIL_MINIMUM_FAMILIES,
  RebuttalObligationSchema,
  autoReducedQuorumWarning,
  resolveHealthyProviders,
} from '../../substrate';
import type { ModeDefinition, ModePrepareInput, ModePrepareOutcome } from '../types';

export const CommitteeOutputSchema = z.strictObject({
  outcome: CouncilOutcomeSchema,
  quorum: QuorumEvaluationSchema,
  rebuttalObligation: RebuttalObligationSchema,
  synthesisEligible: z.boolean(),
  decisionState: PersistedDecisionStateSchema.nullable(),
});

async function prepare(input: ModePrepareInput): Promise<ModePrepareOutcome> {
  if (!input.options.chaired) {
    return { kind: 'ready', options: input.options, unavailableProviders: [] };
  }
  const readiness = await resolveHealthyProviders(input.options, input.adapters, input.context);
  const minimumFamilies =
    input.options.minimumFamilies ??
    (readiness.providerFamilies.length >= DEFAULT_COUNCIL_MINIMUM_FAMILIES
      ? DEFAULT_COUNCIL_MINIMUM_FAMILIES
      : REDUCED_COUNCIL_MINIMUM_FAMILIES);
  if (readiness.providerFamilies.length < minimumFamilies) {
    return {
      kind: 'blocked-quorum',
      message: `Council requires at least ${minimumFamilies} configured, reachable provider families; found ${readiness.providerFamilies.length}.`,
      selectedProviders: readiness.providerFamilies,
      unavailableProviders: readiness.unavailableProviders,
    };
  }
  return {
    kind: 'ready',
    unavailableProviders: readiness.unavailableProviders,
    options: {
      ...input.options,
      providerFamilies: readiness.providerFamilies,
      minimumFamilies,
      ...(minimumFamilies === REDUCED_COUNCIL_MINIMUM_FAMILIES &&
      readiness.providerFamilies.length === REDUCED_COUNCIL_MINIMUM_FAMILIES &&
      readiness.unavailableProviders.length > 0
        ? { reducedQuorumWarning: autoReducedQuorumWarning(readiness.unavailableProviders) }
        : {}),
    },
  };
}

export const committee: ModeDefinition = {
  name: 'committee',
  knobs: {
    participants: 'fixed seats chosen by the lens allocator; quorum counted in distinct families',
    pattern: 'rounds',
    aggregation: 'chair adjudication; dissent recorded; decision record',
    tempo: 'long',
    records: 'ledger, sessions and resolutions',
  },
  pattern: 'rounds',
  defaults: { impact: 'high', contested: true, rounds: 2 },
  spend: { policy: 'capped', defaultCap: (seats, rounds) => seats * rounds },
  outputSchema: CommitteeOutputSchema,
  prepare,
  output({ result, decisionState }) {
    return {
      outcome: result.outcome,
      quorum: result.quorum,
      rebuttalObligation: result.rebuttalObligation,
      synthesisEligible: result.synthesisEligible,
      decisionState,
    };
  },
};
