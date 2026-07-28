import { describe, expect, test } from 'bun:test';
import type { ProviderFamily, QuorumPolicy, SeatResponse } from '../../src/domain/schemas';
import { evaluateQuorum, QuorumEvaluationSchema } from '../../src/domain/quorum';

const normalPolicy = {
  minimumDistinctFamilies: 3,
  requiresContrarian: false,
} satisfies QuorumPolicy;

const significantPolicy = {
  minimumDistinctFamilies: 4,
  requiresContrarian: true,
} satisfies QuorumPolicy;

function successfulSeat(
  provider: ProviderFamily,
  seatId: string,
  role = 'architect',
  actualModel = `${provider}-model`,
): SeatResponse {
  return {
    status: 'ok',
    seatId,
    provider,
    requestedModel: `${provider}-requested`,
    actualModel,
    modelIdentity: 'verified',
    route: 'primary',
    role,
    latencyMs: 1,
    answer: JSON.stringify({ recommendation: `${provider} recommendation` }),
  };
}

function unverifiedSeat(provider: ProviderFamily, seatId: string): SeatResponse {
  return {
    status: 'failed',
    seatId,
    provider,
    requestedModel: `${provider}-requested`,
    actualModel: `${provider}-reported`,
    modelIdentity: 'unverified',
    role: 'architect',
    error: {
      code: 'identity-unverified',
      message: 'The reported model identity could not be verified.',
      retryable: false,
    },
  };
}

describe('quorum evaluation', () => {
  test('counts multiple successful models from one provider family once', () => {
    const evaluation = evaluateQuorum(
      normalPolicy,
      [
        successfulSeat('openai', 'openai-primary', 'architect', 'gpt-primary'),
        successfulSeat('openai', 'openai-fallback', 'maintainer', 'gpt-fallback'),
      ],
      [],
    );

    expect(evaluation.passed).toBe(false);
    expect(evaluation.successfulFamilies).toEqual(['openai']);
    expect(evaluation.failureReasons).toEqual(['insufficient-provider-families']);
  });

  test('does not count a seat whose model identity is unverified', () => {
    const evaluation = evaluateQuorum(
      normalPolicy,
      [
        successfulSeat('openai', 'openai-seat'),
        successfulSeat('xai', 'xai-seat'),
        unverifiedSeat('google', 'google-seat'),
      ],
      [],
    );

    expect(evaluation.passed).toBe(false);
    expect(evaluation.successfulFamilies).toEqual(['openai', 'xai']);
  });

  test('fails a significant motion without a successful contrarian', () => {
    const evaluation = evaluateQuorum(
      significantPolicy,
      [
        successfulSeat('openai', 'openai-seat', 'architect'),
        successfulSeat('xai', 'xai-seat', 'maintainer'),
        successfulSeat('google', 'google-seat', 'security'),
        successfulSeat('deepseek', 'deepseek-seat', 'counter-position'),
      ],
      [],
    );

    expect(evaluation.passed).toBe(false);
    expect(evaluation.contrarianSatisfied).toBe(false);
    expect(evaluation.failureReasons).toEqual(['missing-successful-contrarian']);
  });

  test('passes mixed-family significant quorum and reports families canonically', () => {
    const evaluation = evaluateQuorum(
      significantPolicy,
      [
        successfulSeat('google', 'google-seat', 'maintainer'),
        successfulSeat('xai', 'xai-seat', 'counter-position'),
        successfulSeat('anthropic', 'anthropic-seat', 'architect'),
        successfulSeat('deepseek', 'deepseek-seat', 'security'),
      ],
      ['xai-seat'],
    );

    expect(evaluation.passed).toBe(true);
    expect(evaluation.successfulFamilies).toEqual(['anthropic', 'xai', 'google', 'deepseek']);
    expect(evaluation.contrarianSatisfied).toBe(true);
    expect(evaluation.failureReasons).toEqual([]);
    expect(QuorumEvaluationSchema.parse(evaluation)).toEqual(evaluation);
  });

  test('enforces the normal and significant family floors even for weaker input policy', () => {
    expect(
      evaluateQuorum(
        { minimumDistinctFamilies: 1, requiresContrarian: false },
        [successfulSeat('openai', 'openai-seat')],
        [],
      ).minimumDistinctFamilies,
    ).toBe(3);

    expect(
      evaluateQuorum(
        { minimumDistinctFamilies: 1, requiresContrarian: true },
        [
          successfulSeat('openai', 'openai-seat', 'critic'),
          successfulSeat('google', 'google-seat'),
        ],
        ['openai-seat'],
      ).minimumDistinctFamilies,
    ).toBe(4);
  });

  test('keeps the exported evaluation schema strict', () => {
    const evaluation = evaluateQuorum(
      normalPolicy,
      [
        successfulSeat('openai', 'openai-seat'),
        successfulSeat('xai', 'xai-seat'),
        successfulSeat('google', 'google-seat'),
      ],
      [],
    );

    expect(() => QuorumEvaluationSchema.parse({ ...evaluation, unexpected: true })).toThrow();
  });
});
