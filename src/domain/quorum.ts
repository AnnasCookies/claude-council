import { z } from 'zod';
import {
  ProviderFamilySchema,
  QuorumPolicySchema,
  SeatResponseSchema,
  type ProviderFamily,
  type QuorumPolicy,
  type SeatResponse,
} from './schemas';

export const PROVIDER_FAMILY_ORDER: readonly ProviderFamily[] = Object.freeze([
  ...ProviderFamilySchema.options,
]);

const familyOrder: Record<ProviderFamily, number> = {
  anthropic: 0,
  openai: 1,
  xai: 2,
  google: 3,
  deepseek: 4,
  moonshot: 5,
};

export const QuorumFailureReasonSchema = z.enum([
  'insufficient-provider-families',
  'missing-successful-contrarian',
]);
export type QuorumFailureReason = z.infer<typeof QuorumFailureReasonSchema>;

const SuccessfulFamiliesSchema = z.array(ProviderFamilySchema).superRefine((families, context) => {
  let previousIndex = -1;

  for (const [index, family] of families.entries()) {
    const currentIndex = familyOrder[family];
    if (currentIndex <= previousIndex) {
      context.addIssue({
        code: 'custom',
        path: [index],
        message: 'Successful provider families must be unique and in canonical order',
      });
    }
    previousIndex = currentIndex;
  }
});

export const QuorumEvaluationSchema = z
  .strictObject({
    passed: z.boolean(),
    minimumDistinctFamilies: z.number().int().min(3).max(ProviderFamilySchema.options.length),
    successfulFamilies: SuccessfulFamiliesSchema,
    requiresContrarian: z.boolean(),
    contrarianSatisfied: z.boolean(),
    failureReasons: z.array(QuorumFailureReasonSchema).max(2),
  })
  .superRefine((evaluation, context) => {
    if (evaluation.requiresContrarian && evaluation.minimumDistinctFamilies < 4) {
      context.addIssue({
        code: 'custom',
        path: ['minimumDistinctFamilies'],
        message: 'Significant motions require at least four distinct provider families',
      });
    }

    const insufficientFamilies =
      evaluation.successfulFamilies.length < evaluation.minimumDistinctFamilies;
    const missingContrarian = evaluation.requiresContrarian && !evaluation.contrarianSatisfied;
    const expectedReasons: QuorumFailureReason[] = [];
    if (insufficientFamilies) expectedReasons.push('insufficient-provider-families');
    if (missingContrarian) expectedReasons.push('missing-successful-contrarian');

    if (
      evaluation.failureReasons.length !== expectedReasons.length ||
      evaluation.failureReasons.some((reason, index) => reason !== expectedReasons[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['failureReasons'],
        message: 'Quorum failure reasons do not match the reported evidence',
      });
    }

    if (evaluation.passed !== (expectedReasons.length === 0)) {
      context.addIssue({
        code: 'custom',
        path: ['passed'],
        message: 'Quorum pass state does not match the reported evidence',
      });
    }
  });
export type QuorumEvaluation = z.infer<typeof QuorumEvaluationSchema>;

export function evaluateQuorum(
  policy: QuorumPolicy,
  responses: readonly SeatResponse[],
  contrarianSeatIds: readonly string[],
): QuorumEvaluation {
  const parsedPolicy = QuorumPolicySchema.parse(policy);
  const parsedResponses = z.array(SeatResponseSchema).parse(responses);
  const parsedContrarianSeatIds = z
    .array(z.string().trim().min(1))
    .superRefine((seatIds, context) => {
      if (new Set(seatIds).size !== seatIds.length) {
        context.addIssue({
          code: 'custom',
          message: 'Contrarian seat IDs must be unique',
        });
      }
    })
    .parse(contrarianSeatIds);
  const protocolFloor = parsedPolicy.requiresContrarian ? 4 : 3;
  const minimumDistinctFamilies = Math.max(protocolFloor, parsedPolicy.minimumDistinctFamilies);

  const successfulResponses = parsedResponses.filter(
    (response) => response.status === 'ok' && response.modelIdentity === 'verified',
  );
  const successfulFamilySet = new Set(successfulResponses.map(({ provider }) => provider));
  const successfulFamilies = PROVIDER_FAMILY_ORDER.filter((family) =>
    successfulFamilySet.has(family),
  );
  const contrarianSeatIdSet = new Set(parsedContrarianSeatIds);
  const contrarianSatisfied = successfulResponses.some(({ seatId }) =>
    contrarianSeatIdSet.has(seatId),
  );
  const failureReasons: QuorumFailureReason[] = [];

  if (successfulFamilies.length < minimumDistinctFamilies) {
    failureReasons.push('insufficient-provider-families');
  }
  if (parsedPolicy.requiresContrarian && !contrarianSatisfied) {
    failureReasons.push('missing-successful-contrarian');
  }

  return QuorumEvaluationSchema.parse({
    passed: failureReasons.length === 0,
    minimumDistinctFamilies,
    successfulFamilies,
    requiresContrarian: parsedPolicy.requiresContrarian,
    contrarianSatisfied,
    failureReasons,
  });
}
