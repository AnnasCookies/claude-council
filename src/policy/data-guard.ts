import { createHash } from 'node:crypto';
import { z } from 'zod';
import { classificationAtMost } from '../domain/classification';
import {
  DataClassificationSchema,
  ProjectPolicySchema,
  ProviderFamilySchema,
  type DataClassification,
  type ProjectPolicy,
} from '../domain/schemas';
import { ModelRegistrySchema } from '../models/registry';
import { RedactionResultSchema, scanAndRedact } from './secrets';

const NonEmptyStringSchema = z.string().min(1);
const RunIdSchema = NonEmptyStringSchema.max(256);
const TimestampSchema = z.string().datetime({ offset: true });
const PayloadHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const OutboundDestinationSchema = z.strictObject({
  provider: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
});
export type OutboundDestination = z.infer<typeof OutboundDestinationSchema>;

const OverrideDestinationSchema = z.strictObject({
  provider: ProviderFamilySchema,
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
});
export type OverrideDestination = z.infer<typeof OverrideDestinationSchema>;

export const OverrideRuleSchema = z.enum([
  'provider-policy',
  'provider-allowlist',
  'provider-ceiling',
]);
export type OverrideRule = z.infer<typeof OverrideRuleSchema>;

export const DataPolicyOverrideSchema = z.strictObject({
  runId: RunIdSchema,
  reason: NonEmptyStringSchema.max(2_000),
  authorisingSource: NonEmptyStringSchema.max(256),
  affectedRule: OverrideRuleSchema,
  affectedProviders: z.array(ProviderFamilySchema).min(1),
  classification: DataClassificationSchema,
  destinations: z.array(OverrideDestinationSchema).min(1),
  payloadHashes: z.array(PayloadHashSchema).min(1),
  createdAt: TimestampSchema,
});
export type DataPolicyOverride = z.infer<typeof DataPolicyOverrideSchema>;

export const OverrideInputSchema = z.strictObject({
  runId: RunIdSchema,
  reason: NonEmptyStringSchema.max(2_000),
  authorisingSource: NonEmptyStringSchema.max(256),
  affectedRule: OverrideRuleSchema,
  affectedProviders: z.array(ProviderFamilySchema).min(1),
  classification: DataClassificationSchema,
  destinations: z.array(OverrideDestinationSchema).min(1),
  payloads: z.array(z.string().min(1)).min(1),
  createdAt: TimestampSchema,
});
export type OverrideInput = z.input<typeof OverrideInputSchema>;

export const OutboundPolicyRequestSchema = z.strictObject({
  runId: RunIdSchema.optional(),
  classification: DataClassificationSchema,
  policy: ProjectPolicySchema.optional(),
  destinations: z.array(OutboundDestinationSchema).min(1),
  payloads: z.array(z.string()).min(1),
  override: DataPolicyOverrideSchema.optional(),
});
export type OutboundPolicyRequest = z.input<typeof OutboundPolicyRequestSchema>;

export const POLICY_REASON_CODES = [
  'invalid-policy-request',
  'invalid-payloads',
  'invalid-classification',
  'missing-project-policy',
  'invalid-project-policy',
  'high-confidence-secret-detected',
  'restricted-classification',
  'unknown-provider',
  'provider-not-allowed',
  'provider-ceiling-missing',
  'classification-exceeds-provider-ceiling',
  'invalid-policy-override',
  'override-run-mismatch',
  'override-classification-mismatch',
  'override-payload-mismatch',
  'override-destination-mismatch',
  'override-rule-mismatch',
  'policy-override-applied',
] as const;

export const PolicyReasonCodeSchema = z.enum(POLICY_REASON_CODES);
export type PolicyReasonCode = z.infer<typeof PolicyReasonCodeSchema>;

export const ProviderDispositionKindSchema = z.enum(['allowed', 'blocked', 'overridden']);
export type ProviderDispositionKind = z.infer<typeof ProviderDispositionKindSchema>;

export const ProviderDispositionSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
  kind: ProviderDispositionKindSchema,
  reasonCodes: z.array(PolicyReasonCodeSchema),
});
export type ProviderDisposition = z.infer<typeof ProviderDispositionSchema>;

export const PolicyDecisionSchema = z.strictObject({
  kind: z.enum(['allowed', 'blocked']),
  effectiveClassification: DataClassificationSchema.optional(),
  reasonCodes: z.array(PolicyReasonCodeSchema),
  blockedProviders: z.array(z.string()),
  dispositions: z.array(ProviderDispositionSchema),
  redactions: z.array(RedactionResultSchema),
  override: DataPolicyOverrideSchema.optional(),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

const RegisteredProviderSchema = ModelRegistrySchema.keyof();
const PayloadEnvelopeSchema = z.object({ payloads: z.array(z.string()).min(1) });
const RawRequestEnvelopeSchema = z.object({
  runId: z.unknown().optional(),
  classification: z.unknown().optional(),
  policy: z.unknown().optional(),
  destinations: z.unknown().optional(),
  payloads: z.unknown().optional(),
  override: z.unknown().optional(),
});

function appendReason(reasons: PolicyReasonCode[], reason: PolicyReasonCode): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sanitiseDiagnosticValue(value: string): string {
  const scan = scanAndRedact(value);
  return scan.redacted;
}

function sanitiseUnknownProvider(value: string): string {
  const scan = scanAndRedact(value);
  if (scan.hardBlocked) return scan.redacted;
  return `<UNKNOWN_PROVIDER:${sha256(`UNKNOWN_PROVIDER${value}`).slice(0, 8)}>`;
}

function containsHardSecret(values: readonly string[]): boolean {
  for (const value of values) {
    if (scanAndRedact(value).hardBlocked) return true;
  }
  return false;
}

function overrideContainsHardSecret(override: DataPolicyOverride): boolean {
  return containsHardSecret([
    override.runId,
    override.reason,
    override.authorisingSource,
    override.affectedRule,
    override.createdAt,
    ...override.destinations.flatMap(({ provider, model }) => [provider, model]),
  ]);
}

function ruleCoversViolations(
  rule: OverrideRule,
  violations: readonly PolicyReasonCode[],
): boolean {
  for (const violation of violations) {
    if (violation === 'provider-not-allowed') {
      if (rule !== 'provider-policy' && rule !== 'provider-allowlist') return false;
      continue;
    }
    if (violation === 'provider-ceiling-missing') {
      if (rule !== 'provider-policy' && rule !== 'provider-ceiling') return false;
      continue;
    }
    if (violation === 'classification-exceeds-provider-ceiling') {
      if (rule !== 'provider-policy' && rule !== 'provider-ceiling') return false;
      continue;
    }
    return false;
  }
  return violations.length > 0;
}

export function createOverrideRecord(input: OverrideInput): DataPolicyOverride;
export function createOverrideRecord(input: unknown): DataPolicyOverride {
  const parsed = OverrideInputSchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid policy override input');

  const candidate = parsed.data;
  const sensitiveText = [
    candidate.runId,
    candidate.reason,
    candidate.authorisingSource,
    candidate.affectedRule,
    candidate.createdAt,
    ...candidate.destinations.flatMap(({ provider, model }) => [provider, model]),
    ...candidate.payloads,
  ];
  if (containsHardSecret(sensitiveText)) {
    throw new Error('Override input contains a high-confidence secret');
  }

  const affectedProviders = [...new Set(candidate.affectedProviders)];
  const seenDestinations = new Set<string>();
  const destinations = candidate.destinations.filter(({ provider, model }) => {
    const key = JSON.stringify([provider, model]);
    if (seenDestinations.has(key)) return false;
    seenDestinations.add(key);
    return true;
  });
  const destinationProviders = new Set(destinations.map(({ provider }) => provider));
  const inconsistentProviders =
    affectedProviders.some((provider) => !destinationProviders.has(provider)) ||
    destinations.some(({ provider }) => !affectedProviders.includes(provider));
  if (inconsistentProviders) throw new Error('Invalid policy override input');

  const record = DataPolicyOverrideSchema.safeParse({
    runId: candidate.runId,
    reason: candidate.reason,
    authorisingSource: candidate.authorisingSource,
    affectedRule: candidate.affectedRule,
    affectedProviders,
    classification: candidate.classification,
    destinations,
    payloadHashes: candidate.payloads.map(sha256),
    createdAt: candidate.createdAt,
  });
  if (!record.success) throw new Error('Invalid policy override input');

  return record.data;
}

export function evaluateOutbound(request: OutboundPolicyRequest): PolicyDecision;
export function evaluateOutbound(request: unknown): PolicyDecision;
export function evaluateOutbound(request: unknown): PolicyDecision {
  const reasonCodes: PolicyReasonCode[] = [];

  const payloadEnvelope = PayloadEnvelopeSchema.safeParse(request);
  const payloads = payloadEnvelope.success ? payloadEnvelope.data.payloads : [];
  const redactions = payloads.map(scanAndRedact);
  if (!payloadEnvelope.success) appendReason(reasonCodes, 'invalid-payloads');
  if (redactions.some(({ hardBlocked }) => hardBlocked)) {
    appendReason(reasonCodes, 'high-confidence-secret-detected');
  }

  const rawRequest = RawRequestEnvelopeSchema.safeParse(request);
  if (!rawRequest.success) {
    appendReason(reasonCodes, 'invalid-policy-request');
    return PolicyDecisionSchema.parse({
      kind: 'blocked',
      reasonCodes,
      blockedProviders: [],
      dispositions: [],
      redactions,
    });
  }

  const raw = rawRequest.data;
  const classificationResult = DataClassificationSchema.safeParse(raw.classification);
  if (!classificationResult.success) appendReason(reasonCodes, 'invalid-classification');

  const destinationsResult = z.array(OutboundDestinationSchema).min(1).safeParse(raw.destinations);
  if (!destinationsResult.success) appendReason(reasonCodes, 'invalid-policy-request');
  const destinations = destinationsResult.success ? destinationsResult.data : [];

  let policy: ProjectPolicy | undefined;
  if (raw.policy === undefined) {
    appendReason(reasonCodes, 'missing-project-policy');
  } else {
    const policyResult = ProjectPolicySchema.safeParse(raw.policy);
    if (policyResult.success) policy = policyResult.data;
    else appendReason(reasonCodes, 'invalid-project-policy');
  }

  const runIdResult = raw.runId === undefined ? undefined : RunIdSchema.safeParse(raw.runId);
  if (runIdResult !== undefined && !runIdResult.success) {
    appendReason(reasonCodes, 'invalid-policy-request');
  }
  const runId = runIdResult?.success === true ? runIdResult.data : undefined;

  let override: DataPolicyOverride | undefined;
  if (raw.override !== undefined) {
    const overrideResult = DataPolicyOverrideSchema.safeParse(raw.override);
    if (!overrideResult.success) {
      appendReason(reasonCodes, 'invalid-policy-override');
    } else if (overrideContainsHardSecret(overrideResult.data)) {
      appendReason(reasonCodes, 'invalid-policy-override');
    } else {
      override = overrideResult.data;
    }
  }

  const fieldValidationFailed =
    !payloadEnvelope.success ||
    !classificationResult.success ||
    !destinationsResult.success ||
    (raw.policy !== undefined && policy === undefined) ||
    (runIdResult !== undefined && !runIdResult.success) ||
    (raw.override !== undefined && override === undefined);
  if (!OutboundPolicyRequestSchema.safeParse(request).success && !fieldValidationFailed) {
    appendReason(reasonCodes, 'invalid-policy-request');
  }

  let effectiveClassification: DataClassification | undefined;
  if (classificationResult.success && policy !== undefined) {
    effectiveClassification = classificationAtMost(policy.classification, classificationResult.data)
      ? classificationResult.data
      : policy.classification;
    if (effectiveClassification === 'restricted') {
      appendReason(reasonCodes, 'restricted-classification');
    }
  }

  if (
    destinations.some(
      ({ provider, model }) =>
        scanAndRedact(provider).hardBlocked || scanAndRedact(model).hardBlocked,
    )
  ) {
    appendReason(reasonCodes, 'high-confidence-secret-detected');
  }

  let overrideMetadataApplicable = false;
  if (override !== undefined) {
    if (runId !== override.runId) appendReason(reasonCodes, 'override-run-mismatch');
    if (effectiveClassification !== override.classification) {
      appendReason(reasonCodes, 'override-classification-mismatch');
    }

    const requestPayloadHashes = payloads.map(sha256);
    const payloadHashesMatch =
      requestPayloadHashes.length === override.payloadHashes.length &&
      requestPayloadHashes.every((hash, index) => hash === override.payloadHashes[index]);
    if (!payloadHashesMatch) appendReason(reasonCodes, 'override-payload-mismatch');

    overrideMetadataApplicable =
      runId === override.runId &&
      effectiveClassification === override.classification &&
      payloadHashesMatch;
  }

  const nonRouteReasons = [...reasonCodes];
  const dispositions: ProviderDisposition[] = [];

  for (const destination of destinations) {
    const localReasons = [...nonRouteReasons];
    const registeredProviderResult = RegisteredProviderSchema.safeParse(destination.provider);
    const registeredProvider = registeredProviderResult.success
      ? registeredProviderResult.data
      : undefined;
    const routeViolations: PolicyReasonCode[] = [];

    if (registeredProvider === undefined) {
      appendReason(routeViolations, 'unknown-provider');
    } else if (policy !== undefined && effectiveClassification !== undefined) {
      if (!policy.allowedProviders.includes(registeredProvider)) {
        appendReason(routeViolations, 'provider-not-allowed');
      } else {
        const ceiling = policy.providerCeilings?.[registeredProvider];
        if (ceiling === undefined) {
          appendReason(routeViolations, 'provider-ceiling-missing');
        } else if (!classificationAtMost(effectiveClassification, ceiling)) {
          appendReason(routeViolations, 'classification-exceeds-provider-ceiling');
        }
      }
    }

    let dispositionKind: ProviderDispositionKind = 'allowed';
    const destinationIsApproved =
      override !== undefined &&
      registeredProvider !== undefined &&
      override.affectedProviders.includes(registeredProvider) &&
      override.destinations.some(
        ({ provider, model }) => provider === registeredProvider && model === destination.model,
      );
    const canOverride =
      nonRouteReasons.length === 0 &&
      override !== undefined &&
      overrideMetadataApplicable &&
      destinationIsApproved &&
      ruleCoversViolations(override.affectedRule, routeViolations);

    if (canOverride) {
      dispositionKind = 'overridden';
      appendReason(localReasons, 'policy-override-applied');
      appendReason(reasonCodes, 'policy-override-applied');
    } else {
      for (const violation of routeViolations) {
        appendReason(localReasons, violation);
        appendReason(reasonCodes, violation);
      }

      if (
        routeViolations.length > 0 &&
        nonRouteReasons.length === 0 &&
        override !== undefined &&
        overrideMetadataApplicable
      ) {
        if (!destinationIsApproved) {
          appendReason(localReasons, 'override-destination-mismatch');
          appendReason(reasonCodes, 'override-destination-mismatch');
        } else if (!ruleCoversViolations(override.affectedRule, routeViolations)) {
          appendReason(localReasons, 'override-rule-mismatch');
          appendReason(reasonCodes, 'override-rule-mismatch');
        }
      }

      if (localReasons.length > 0) dispositionKind = 'blocked';
    }

    const provider = registeredProvider ?? sanitiseUnknownProvider(destination.provider);
    dispositions.push({
      provider,
      model: sanitiseDiagnosticValue(destination.model),
      kind: dispositionKind,
      reasonCodes: localReasons,
    });
  }

  const blockedProviders = [
    ...new Set(
      dispositions.filter(({ kind }) => kind === 'blocked').map(({ provider }) => provider),
    ),
  ];
  const hasBlockingReason = reasonCodes.some((reason) => reason !== 'policy-override-applied');
  const kind =
    hasBlockingReason || dispositions.some(({ kind: disposition }) => disposition === 'blocked')
      ? 'blocked'
      : 'allowed';

  return PolicyDecisionSchema.parse({
    kind,
    ...(effectiveClassification === undefined ? {} : { effectiveClassification }),
    reasonCodes,
    blockedProviders,
    dispositions,
    redactions,
    ...(override === undefined ? {} : { override }),
  });
}
