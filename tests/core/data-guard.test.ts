import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import type { ProjectPolicy } from '../../src/domain/schemas';
import {
  createOverrideRecord,
  evaluateOutbound,
  type DataPolicyOverride,
} from '../../src/policy/data-guard';

const TIMESTAMP = '2026-07-27T00:00:00.000Z';

function projectPolicy(overrides: Partial<ProjectPolicy> = {}): ProjectPolicy {
  return {
    projectId: 'example',
    classification: 'confidential',
    allowedProviders: ['anthropic'],
    providerCeilings: { anthropic: 'confidential' },
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

describe('outbound data policy', () => {
  test('scans every payload before missing policy fails closed', () => {
    const secret = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
    const result = evaluateOutbound({
      classification: 'internal',
      policy: undefined,
      destinations: [{ provider: 'openai', model: 'gpt-5.6-sol' }],
      payloads: ['architecture notes', 'a second assembled section', `token=${secret}`],
    });
    const serialised = JSON.stringify(result);

    expect(result.kind).toBe('blocked');
    expect(result.reasonCodes).toContain('missing-project-policy');
    expect(result.reasonCodes).toContain('high-confidence-secret-detected');
    expect(result.redactions).toHaveLength(3);
    expect(result.redactions[2]?.hardBlocked).toBe(true);
    expect(serialised.includes(secret)).toBe(false);
  });

  test('allows a clean payload only when every requested provider is within policy', () => {
    const result = evaluateOutbound({
      classification: 'internal',
      policy: projectPolicy({
        classification: 'internal',
        allowedProviders: ['anthropic', 'openai'],
        providerCeilings: { anthropic: 'internal', openai: 'internal' },
      }),
      destinations: [
        { provider: 'anthropic', model: 'claude-opus-5' },
        { provider: 'openai', model: 'gpt-5.6-sol' },
      ],
      payloads: ['architecture notes'],
    });

    expect(result.kind).toBe('allowed');
    expect(result.reasonCodes).toEqual([]);
    expect(result.blockedProviders).toEqual([]);
    expect(result.dispositions.map(({ kind }) => kind)).toEqual(['allowed', 'allowed']);
    expect(result.redactions[0]?.redacted).toBe('architecture notes');
  });

  test('blocks only the disallowed provider in per-provider dispositions', () => {
    const result = evaluateOutbound({
      classification: 'confidential',
      policy: projectPolicy(),
      destinations: [
        { provider: 'anthropic', model: 'claude-opus-5' },
        { provider: 'openai', model: 'gpt-5.6-sol' },
      ],
      payloads: ['proprietary design'],
    });

    expect(result.kind).toBe('blocked');
    expect(result.blockedProviders).toEqual(['openai']);
    expect(result.dispositions).toEqual([
      {
        provider: 'anthropic',
        model: 'claude-opus-5',
        kind: 'allowed',
        reasonCodes: [],
      },
      {
        provider: 'openai',
        model: 'gpt-5.6-sol',
        kind: 'blocked',
        reasonCodes: ['provider-not-allowed'],
      },
    ]);
  });

  test('blocks a provider whose effective classification exceeds its ceiling', () => {
    const result = evaluateOutbound({
      classification: 'confidential',
      policy: projectPolicy({
        allowedProviders: ['openai'],
        providerCeilings: { openai: 'internal' },
      }),
      destinations: [{ provider: 'openai', model: 'gpt-5.6-sol' }],
      payloads: ['proprietary design'],
    });

    expect(result.kind).toBe('blocked');
    expect(result.reasonCodes).toEqual(['classification-exceeds-provider-ceiling']);
    expect(result.blockedProviders).toEqual(['openai']);
    expect(result.dispositions[0]?.reasonCodes).toEqual([
      'classification-exceeds-provider-ceiling',
    ]);
  });

  test('blocks an allowlisted provider when its classification ceiling is missing', () => {
    const result = evaluateOutbound({
      classification: 'public',
      policy: projectPolicy({
        classification: 'public',
        allowedProviders: ['openai'],
        providerCeilings: {},
      }),
      destinations: [{ provider: 'openai', model: 'gpt-5.6-sol' }],
      payloads: ['public architecture notes'],
    });

    expect(result.kind).toBe('blocked');
    expect(result.reasonCodes).toEqual(['provider-ceiling-missing']);
    expect(result.blockedProviders).toEqual(['openai']);
    expect(result.dispositions[0]?.reasonCodes).toEqual(['provider-ceiling-missing']);
  });

  test('raises a caller classification to the stricter project default', () => {
    const result = evaluateOutbound({
      classification: 'public',
      policy: projectPolicy({
        classification: 'confidential',
        allowedProviders: ['google'],
        providerCeilings: { google: 'internal' },
      }),
      destinations: [{ provider: 'google', model: 'gemini-3.1-pro-preview' }],
      payloads: ['apparently public excerpt'],
    });

    expect(result.effectiveClassification).toBe('confidential');
    expect(result.kind).toBe('blocked');
    expect(result.reasonCodes).toContain('classification-exceeds-provider-ceiling');
  });

  test('blocks restricted data independently of provider policy', () => {
    const result = evaluateOutbound({
      classification: 'restricted',
      policy: projectPolicy({
        classification: 'restricted',
        allowedProviders: ['anthropic'],
        providerCeilings: { anthropic: 'restricted' },
      }),
      destinations: [{ provider: 'anthropic', model: 'claude-opus-5' }],
      payloads: ['locally restricted material'],
    });

    expect(result.kind).toBe('blocked');
    expect(result.reasonCodes).toContain('restricted-classification');
    expect(result.blockedProviders).toEqual(['anthropic']);
  });

  test('does not echo an unknown provider or secret-shaped model into diagnostics', () => {
    const unknownProvider = ['sk', 'proj', 'unknownprovider01234567890123456789'].join('-');
    const secretModel = `xai-${'s'.repeat(40)}`;
    const result = evaluateOutbound({
      classification: 'internal',
      policy: projectPolicy({ classification: 'internal' }),
      destinations: [{ provider: unknownProvider, model: secretModel }],
      payloads: ['clean payload'],
    });
    const serialised = JSON.stringify(result);

    expect(result.kind).toBe('blocked');
    expect(result.reasonCodes).toContain('unknown-provider');
    expect(result.blockedProviders).toHaveLength(1);
    expect(serialised.includes(unknownProvider)).toBe(false);
    expect(serialised.includes(secretModel)).toBe(false);
    expect(result.dispositions[0]?.provider).toMatch(/^<SECRET:OPENAI:[a-f0-9]{8}>$/);
    expect(result.dispositions[0]?.model).toMatch(/^<SECRET:XAI:[a-f0-9]{8}>$/);
  });

  test('returns sanitised fail-closed diagnostics for malformed external input', () => {
    const malformedPolicy = {
      classification: 'internal',
      policy: { allowedProviders: ['anthropic'], password: 'must-not-be-diagnosed' },
      destinations: [{ provider: 'anthropic', model: 'claude-opus-5' }],
      payloads: ['clean payload'],
    };
    const result = evaluateOutbound(malformedPolicy);

    expect(result.kind).toBe('blocked');
    expect(result.reasonCodes).toContain('invalid-project-policy');
    expect(JSON.stringify(result).includes('must-not-be-diagnosed')).toBe(false);
  });
});

describe('one-run policy overrides', () => {
  test('creates an explicit audit record and permits only its exact run payload and destination', () => {
    const payloads = ['approved proprietary design'];
    const override = createOverrideRecord({
      runId: 'run-001',
      reason: 'Explicitly approved for this independent review',
      authorisingSource: 'interactive-user-confirmation',
      affectedRule: 'provider-policy',
      affectedProviders: ['openai'],
      classification: 'confidential',
      destinations: [{ provider: 'openai', model: 'gpt-5.6-sol' }],
      payloads,
      createdAt: TIMESTAMP,
    });
    const payloadHash = createHash('sha256')
      .update(payloads[0] ?? '')
      .digest('hex');

    expect(override).toEqual({
      runId: 'run-001',
      reason: 'Explicitly approved for this independent review',
      authorisingSource: 'interactive-user-confirmation',
      affectedRule: 'provider-policy',
      affectedProviders: ['openai'],
      classification: 'confidential',
      destinations: [{ provider: 'openai', model: 'gpt-5.6-sol' }],
      payloadHashes: [payloadHash],
      createdAt: TIMESTAMP,
    });

    const result = evaluateOutbound({
      runId: 'run-001',
      classification: 'confidential',
      policy: projectPolicy(),
      destinations: [{ provider: 'openai', model: 'gpt-5.6-sol' }],
      payloads,
      override,
    });

    expect(result.kind).toBe('allowed');
    expect(result.reasonCodes).toEqual(['policy-override-applied']);
    expect(result.blockedProviders).toEqual([]);
    expect(result.dispositions[0]?.kind).toBe('overridden');
    expect(result.override).toEqual(override);
  });

  test('does not apply an override to a different run or payload', () => {
    const override = createOverrideRecord({
      runId: 'run-001',
      reason: 'Explicitly approved for one run only',
      authorisingSource: 'interactive-user-confirmation',
      affectedRule: 'provider-policy',
      affectedProviders: ['openai'],
      classification: 'confidential',
      destinations: [{ provider: 'openai', model: 'gpt-5.6-sol' }],
      payloads: ['approved payload'],
      createdAt: TIMESTAMP,
    });

    const result = evaluateOutbound({
      runId: 'run-002',
      classification: 'confidential',
      policy: projectPolicy(),
      destinations: [{ provider: 'openai', model: 'gpt-5.6-sol' }],
      payloads: ['different payload'],
      override,
    });

    expect(result.kind).toBe('blocked');
    expect(result.reasonCodes).toContain('provider-not-allowed');
    expect(result.reasonCodes).toContain('override-run-mismatch');
    expect(result.reasonCodes).toContain('override-payload-mismatch');
  });

  test('a maximally permissive record cannot override a high-confidence secret', () => {
    const secret = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
    const payload = `token=${secret}`;
    const override: DataPolicyOverride = {
      runId: 'run-secret',
      reason: 'Attempted explicit approval',
      authorisingSource: 'interactive-user-confirmation',
      affectedRule: 'provider-policy',
      affectedProviders: ['openai'],
      classification: 'confidential',
      destinations: [{ provider: 'openai', model: 'gpt-5.6-sol' }],
      payloadHashes: [createHash('sha256').update(payload).digest('hex')],
      createdAt: TIMESTAMP,
    };

    const result = evaluateOutbound({
      runId: 'run-secret',
      classification: 'confidential',
      policy: projectPolicy(),
      destinations: [{ provider: 'openai', model: 'gpt-5.6-sol' }],
      payloads: [payload],
      override,
    });

    expect(result.kind).toBe('blocked');
    expect(result.reasonCodes).toContain('high-confidence-secret-detected');
    expect(result.dispositions[0]?.kind).toBe('blocked');
    expect(JSON.stringify(result).includes(secret)).toBe(false);
  });

  test('refuses to authorise an override record containing a high-confidence secret', () => {
    const secret = `xai-${'z'.repeat(40)}`;
    let diagnostic = '';

    try {
      createOverrideRecord({
        runId: 'run-secret',
        reason: 'Explicitly approved',
        authorisingSource: 'interactive-user-confirmation',
        affectedRule: 'provider-policy',
        affectedProviders: ['xai'],
        classification: 'internal',
        destinations: [{ provider: 'xai', model: 'grok-4.5' }],
        payloads: [`token=${secret}`],
        createdAt: TIMESTAMP,
      });
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
    }

    expect(diagnostic).toBe('Override input contains a high-confidence secret');
    expect(diagnostic.includes(secret)).toBe(false);
  });
});
