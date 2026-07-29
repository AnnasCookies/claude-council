import { z } from 'zod';
import {
  ModelRouteSchema,
  ModelTransportSchema,
  ProviderFamilySchema,
  type ProviderFamily,
} from '../domain/schemas';
import type { ProviderAdapter, ProviderContext } from '../execution/provider';
import { HealthErrorCategorySchema, ModelIdentityStateSchema, snapshot } from './baseline';
import { HealthStatusSchema, probeRoster, type ProviderProbe } from './probe';

const TimestampSchema = z.string().datetime({ offset: true });
const ModelIdentifierSchema = z.string().min(1).max(512);

export const DoctorStatusSchema = z.enum(['healthy', 'degraded', 'unavailable']);
export type DoctorStatus = z.infer<typeof DoctorStatusSchema>;

export const RouteResolutionSchema = z.strictObject({
  kind: z.enum(['endpoint', 'executable']),
  status: z.enum(['resolved', 'unresolved', 'unsafe']),
});
export type RouteResolution = z.infer<typeof RouteResolutionSchema>;

export const ToolIsolationSchema = z.enum(['supported', 'unsupported', 'not-applicable']);
export type ToolIsolation = z.infer<typeof ToolIsolationSchema>;

export const RemediationCodeSchema = z.enum([
  'configure-provider',
  'secure-transport',
  'restore-provider',
  'verify-model-identity',
  'review-route-drift',
]);
export type RemediationCode = z.infer<typeof RemediationCodeSchema>;

export const DoctorRemediationSchema = z.strictObject({
  provider: ProviderFamilySchema,
  code: RemediationCodeSchema,
  action: z.string().min(1).max(500),
});
export type DoctorRemediation = z.infer<typeof DoctorRemediationSchema>;

export const ProviderDiagnosticSchema = z.strictObject({
  provider: ProviderFamilySchema,
  transport: ModelTransportSchema,
  resolution: RouteResolutionSchema,
  route: ModelRouteSchema,
  requestedModel: ModelIdentifierSchema,
  actualModel: ModelIdentifierSchema.nullable(),
  identity: ModelIdentityStateSchema,
  status: HealthStatusSchema,
  latencyMs: z.number().finite().nonnegative(),
  errorCategory: HealthErrorCategorySchema,
  toolIsolation: ToolIsolationSchema,
  detail: z.string().max(500),
  candidateSuccessorWarnings: z.array(z.string().min(1).max(1_000)),
  remediationCodes: z.array(RemediationCodeSchema),
});
export type ProviderDiagnostic = z.infer<typeof ProviderDiagnosticSchema>;

export const DoctorReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  capturedAt: TimestampSchema,
  status: DoctorStatusSchema,
  totalOutage: z.boolean(),
  diagnostics: z.array(ProviderDiagnosticSchema),
  remediations: z.array(DoctorRemediationSchema),
});
export type DoctorReport = z.infer<typeof DoctorReportSchema>;

const REMEDIATION_ACTIONS: Record<RemediationCode, string> = {
  'configure-provider': 'Configure the provider credential or executable, then rerun doctor.',
  'secure-transport': 'Use a trusted absolute executable with tool-free, stateless invocation.',
  'restore-provider': 'Check provider reachability and retry the route probe.',
  'verify-model-identity': 'Require observable actual-model metadata before relying on this route.',
  'review-route-drift':
    'Review and explicitly authorise the route or model change before updating the baseline.',
};

function routeResolution(probe: ProviderProbe): RouteResolution {
  const kind = probe.transport === 'http' ? 'endpoint' : 'executable';
  const status =
    probe.availability === 'unconfigured' || probe.status === 'unconfigured'
      ? 'unresolved'
      : probe.availability === 'unsafe-transport' || probe.status === 'unsafe-transport'
        ? 'unsafe'
        : 'resolved';
  return RouteResolutionSchema.parse({ kind, status });
}

function toolIsolation(probe: ProviderProbe): ToolIsolation {
  if (probe.transport === 'http') return 'not-applicable';
  return probe.status === 'unsafe-transport' ? 'unsupported' : 'supported';
}

function remediationCodes(probe: ProviderProbe, configuredPrimary: string): RemediationCode[] {
  const codes: RemediationCode[] = [];
  switch (probe.status) {
    case 'healthy':
      break;
    case 'identity-unverified':
      codes.push('verify-model-identity');
      break;
    case 'down':
      codes.push('restore-provider');
      break;
    case 'unconfigured':
      codes.push('configure-provider');
      break;
    case 'unsafe-transport':
      codes.push('secure-transport');
      break;
  }
  if (
    probe.requestedModel !== configuredPrimary ||
    (probe.actualModel !== null && probe.actualModel !== configuredPrimary)
  ) {
    codes.push('review-route-drift');
  }
  return codes;
}

function successorWarnings(probe: ProviderProbe, route: ProviderDiagnostic['route']): string[] {
  const warnings: string[] = [];
  if (probe.requestedModel !== route.primary) {
    warnings.push('The adapter requested a model outside the configured primary route.');
  }
  if (probe.actualModel !== null && probe.actualModel !== route.primary) {
    warnings.push(
      route.fallbacks.includes(probe.actualModel)
        ? 'The probe observed an approved same-provider fallback instead of the configured primary.'
        : 'The probe observed an actual model outside the configured route.',
    );
  }
  if (probe.status !== 'healthy') {
    for (const candidate of route.fallbacks) {
      warnings.push(`Configured candidate successor ${candidate} was not selected by this probe.`);
    }
  }
  return warnings;
}

function reportStatus(diagnostics: readonly ProviderDiagnostic[]): DoctorStatus {
  if (
    diagnostics.length > 0 &&
    diagnostics.every(
      ({ status, remediationCodes }) => status === 'healthy' && remediationCodes.length === 0,
    )
  ) {
    return 'healthy';
  }
  if (diagnostics.some(({ status }) => status === 'healthy' || status === 'identity-unverified')) {
    return 'degraded';
  }
  return 'unavailable';
}

/** Runs live adapter diagnostics without retaining environment values or raw provider output. */
export async function doctor(
  adapters: readonly ProviderAdapter[],
  context: ProviderContext,
  capturedAt = new Date().toISOString(),
): Promise<DoctorReport> {
  const probes = await probeRoster(adapters, context);
  const baseline = snapshot(probes, context.registry, capturedAt);
  const probeByProvider = new Map<ProviderFamily, ProviderProbe>(
    probes.map((probe) => [probe.provider, probe] as const),
  );
  const remediations: DoctorRemediation[] = [];
  const diagnostics = baseline.providers.map((health): ProviderDiagnostic => {
    const probe = probeByProvider.get(health.provider);
    if (probe === undefined) throw new Error('Missing provider probe for doctor diagnostic');
    const codes = remediationCodes(probe, health.route.primary);
    for (const code of codes) {
      remediations.push({
        provider: health.provider,
        code,
        action: REMEDIATION_ACTIONS[code],
      });
    }
    return ProviderDiagnosticSchema.parse({
      provider: health.provider,
      transport: probe.transport,
      resolution: routeResolution(probe),
      route: health.route,
      requestedModel: health.requestedModel,
      actualModel: health.actualModel,
      identity: health.identity,
      status: health.status,
      latencyMs: health.latencyMs,
      errorCategory: health.errorCategory,
      toolIsolation: toolIsolation(probe),
      detail: probe.reason,
      candidateSuccessorWarnings: successorWarnings(probe, health.route),
      remediationCodes: codes,
    });
  });
  const status = reportStatus(diagnostics);

  return DoctorReportSchema.parse({
    schemaVersion: 1,
    capturedAt: baseline.capturedAt,
    status,
    totalOutage: status === 'unavailable',
    diagnostics,
    remediations,
  });
}
