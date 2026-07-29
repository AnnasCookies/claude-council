import { z } from 'zod';
import { ModelTransportSchema, ProviderFamilySchema, type ProviderFamily } from '../domain/schemas';
import type {
  Availability,
  HealthResult,
  ProviderAdapter,
  ProviderContext,
} from '../execution/provider';
import { scanAndRedact } from '../policy/secrets';

export const AvailabilityStatusSchema = z.enum(['available', 'unconfigured', 'unsafe-transport']);
export type AvailabilityStatus = z.infer<typeof AvailabilityStatusSchema>;

export const HealthStatusSchema = z.enum([
  'healthy',
  'identity-unverified',
  'down',
  'unconfigured',
  'unsafe-transport',
]);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

const ModelIdentifierSchema = z.string().min(1).max(512);
const DiagnosticReasonSchema = z.string().max(500);

const AvailabilityContractSchema = z.strictObject({
  status: AvailabilityStatusSchema,
  provider: ProviderFamilySchema,
  model: z.string().min(1),
  reason: z.string(),
});

const HealthContractSchema = z.strictObject({
  status: HealthStatusSchema,
  provider: ProviderFamilySchema,
  requestedModel: z.string().min(1),
  actualModel: z.string().min(1).nullable(),
  latencyMs: z.number().finite().nonnegative(),
  reason: z.string(),
});

export const ProviderProbeSchema = z.strictObject({
  provider: ProviderFamilySchema,
  transport: ModelTransportSchema,
  availability: AvailabilityStatusSchema,
  status: HealthStatusSchema,
  requestedModel: ModelIdentifierSchema,
  actualModel: ModelIdentifierSchema.nullable(),
  latencyMs: z.number().finite().nonnegative(),
  reason: DiagnosticReasonSchema,
});
export type ProviderProbe = z.infer<typeof ProviderProbeSchema>;

export const ProviderRosterProbeSchema = z.array(ProviderProbeSchema);
export type ProviderRosterProbe = z.infer<typeof ProviderRosterProbeSchema>;

function sanitiseModel(value: string): string {
  const sanitised = scanAndRedact(value).redacted.replace(/\s+/g, ' ').trim();
  return (sanitised || '[invalid model identity]').slice(0, 512);
}

function sanitiseReason(value: string, fallback: string): string {
  const sanitised = scanAndRedact(value).redacted.replace(/\s+/g, ' ').trim();
  return (sanitised || fallback).slice(0, 500);
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'provider operation failed';
  }
}

function failedProbe(
  provider: ProviderFamily,
  transport: ProviderProbe['transport'],
  requestedModel: string,
  availability: AvailabilityStatus,
  reason: string,
): ProviderProbe {
  return ProviderProbeSchema.parse({
    provider,
    transport,
    availability,
    status: availability === 'unsafe-transport' ? 'unsafe-transport' : 'down',
    requestedModel: sanitiseModel(requestedModel),
    actualModel: null,
    latencyMs: 0,
    reason: sanitiseReason(reason, 'provider health contract failed'),
  });
}

async function probeAdapter(
  adapter: ProviderAdapter,
  context: ProviderContext,
): Promise<ProviderProbe> {
  const provider = ProviderFamilySchema.parse(adapter.family);
  const configuredRoute = context.registry[provider];
  const transport = ModelTransportSchema.parse(adapter.transport);
  const requestedModel = sanitiseModel(configuredRoute.primary);

  if (transport !== configuredRoute.transport) {
    return failedProbe(
      provider,
      transport,
      requestedModel,
      'unsafe-transport',
      'adapter transport does not match the configured route',
    );
  }

  let availability: Availability;
  try {
    availability = await adapter.availability(context);
  } catch (error) {
    return failedProbe(
      provider,
      transport,
      requestedModel,
      'available',
      sanitiseReason(errorMessage(error), 'provider availability check failed'),
    );
  }

  const parsedAvailability = AvailabilityContractSchema.safeParse(availability);
  if (!parsedAvailability.success || parsedAvailability.data.provider !== provider) {
    return failedProbe(
      provider,
      transport,
      requestedModel,
      'available',
      'provider availability contract returned an invalid result',
    );
  }

  if (parsedAvailability.data.status !== 'available') {
    return ProviderProbeSchema.parse({
      provider,
      transport,
      availability: parsedAvailability.data.status,
      status: parsedAvailability.data.status,
      requestedModel,
      actualModel: null,
      latencyMs: 0,
      reason: sanitiseReason(
        parsedAvailability.data.reason,
        parsedAvailability.data.status === 'unconfigured'
          ? 'provider route is not configured'
          : 'provider transport is unsafe',
      ),
    });
  }

  let health: HealthResult;
  try {
    health = await adapter.probe(context);
  } catch (error) {
    return failedProbe(
      provider,
      transport,
      requestedModel,
      'available',
      sanitiseReason(errorMessage(error), 'provider probe failed'),
    );
  }

  const parsedHealth = HealthContractSchema.safeParse(health);
  if (!parsedHealth.success || parsedHealth.data.provider !== provider) {
    return failedProbe(
      provider,
      transport,
      requestedModel,
      'available',
      'provider probe contract returned an invalid result',
    );
  }

  const identityUnverified =
    parsedHealth.data.status === 'identity-unverified' ||
    (parsedHealth.data.status === 'healthy' && parsedHealth.data.actualModel === null);
  const status: HealthStatus = identityUnverified
    ? 'identity-unverified'
    : parsedHealth.data.status;
  const actualModel =
    parsedHealth.data.actualModel === null ? null : sanitiseModel(parsedHealth.data.actualModel);

  return ProviderProbeSchema.parse({
    provider,
    transport,
    availability: 'available',
    status,
    requestedModel: sanitiseModel(parsedHealth.data.requestedModel),
    actualModel,
    latencyMs: parsedHealth.data.latencyMs,
    reason: sanitiseReason(
      parsedHealth.data.reason,
      status === 'identity-unverified'
        ? 'provider response did not expose actual model identity'
        : status === 'healthy'
          ? ''
          : 'provider probe failed',
    ),
  });
}

/** Probes each adapter concurrently while preserving the supplied roster order. */
export async function probeRoster(
  adapters: readonly ProviderAdapter[],
  context: ProviderContext,
): Promise<ProviderRosterProbe> {
  return ProviderRosterProbeSchema.parse(
    await Promise.all(adapters.map((adapter) => probeAdapter(adapter, context))),
  );
}
