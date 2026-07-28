import { describe, expect, test } from 'bun:test';
import {
  CouncilScopeSchema,
  DataClassificationSchema,
  ProjectPolicySchema,
  SeatResponseSchema,
} from '../../src/domain/schemas';

describe('domain schemas', () => {
  test('accepts only the declared data classifications', () => {
    for (const classification of DataClassificationSchema.options) {
      expect(DataClassificationSchema.parse(classification)).toBe(classification);
    }

    for (const classification of ['', 'Public', 'secret', 'restricted ']) {
      expect(() => DataClassificationSchema.parse(classification)).toThrow();
    }
  });

  test('accepts only general and project council scopes', () => {
    expect(CouncilScopeSchema.parse('general')).toBe('general');
    expect(CouncilScopeSchema.parse('project')).toBe('project');
    expect(() => CouncilScopeSchema.parse('global')).toThrow();
  });

  test('rejects an unknown project classification', () => {
    expect(() =>
      ProjectPolicySchema.parse({
        projectId: 'host-owner-repo-a1b2c3d4e5f6',
        classification: 'secret',
        allowedProviders: [],
        providerCeilings: {},
        createdAt: '2026-07-27T00:00:00.000Z',
        updatedAt: '2026-07-27T00:00:00.000Z',
      }),
    ).toThrow();
  });

  test('requires exact identities, route, latency and answer on a successful seat', () => {
    expect(() => SeatResponseSchema.parse({ status: 'ok', answer: 'yes' })).toThrow();

    expect(
      SeatResponseSchema.parse({
        status: 'ok',
        seatId: 'seat-deepseek',
        provider: 'deepseek',
        requestedModel: 'deepseek-v4-pro',
        actualModel: 'deepseek-v4-flash',
        modelIdentity: 'verified',
        route: 'same-provider-fallback',
        role: 'critic',
        latencyMs: 125,
        answer: 'Use the fallback result.',
      }),
    ).toEqual({
      status: 'ok',
      seatId: 'seat-deepseek',
      provider: 'deepseek',
      requestedModel: 'deepseek-v4-pro',
      actualModel: 'deepseek-v4-flash',
      modelIdentity: 'verified',
      route: 'same-provider-fallback',
      role: 'critic',
      latencyMs: 125,
      answer: 'Use the fallback result.',
    });
  });

  test('does not admit unknown fields at domain boundaries', () => {
    expect(() =>
      ProjectPolicySchema.parse({
        projectId: 'host-owner-repo-a1b2c3d4e5f6',
        classification: 'internal',
        allowedProviders: ['anthropic'],
        createdAt: '2026-07-27T00:00:00.000Z',
        updatedAt: '2026-07-27T00:00:00.000Z',
        classificationOverride: 'public',
      }),
    ).toThrow();
  });
});
