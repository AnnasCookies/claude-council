import { z } from 'zod';
import {
  ModelRouteSchema,
  ProviderFamilySchema,
  type ModelRoute,
  type ProviderFamily,
} from '../domain/schemas';
import { ModelRegistrySchema, type ModelRegistry } from '../models/registry';
import { scanAndRedact } from '../policy/secrets';
import {
  HealthStatusSchema,
  ProviderRosterProbeSchema,
  type HealthStatus,
  type ProviderProbe,
} from './probe';

const TimestampSchema = z.string().datetime({ offset: true });
const ModelIdentifierSchema = z.string().min(1).max(512);

export const ModelIdentityStateSchema = z.enum(['verified', 'unverified', 'unavailable']);
export type ModelIdentityState = z.infer<typeof ModelIdentityStateSchema>;

export const HealthErrorCategorySchema = z.enum([
  'none',
  'identity-unverified',
  'provider-down',
  'unconfigured',
  'unsafe-transport',
]);
export type HealthErrorCategory = z.infer<typeof HealthErrorCategorySchema>;

export const ObservedRouteSchema = z.enum([
  'primary',
  'same-provider-fallback',
  'outside-configured-route',
  'unverified',
  'unavailable',
]);
export type ObservedRoute = z.infer<typeof ObservedRouteSchema>;

export const ProviderRouteHealthSchema = z.strictObject({
  provider: ProviderFamilySchema,
  route: ModelRouteSchema,
  observedRoute: ObservedRouteSchema,
  requestedModel: ModelIdentifierSchema,
  actualModel: ModelIdentifierSchema.nullable(),
  identity: ModelIdentityStateSchema,
  status: HealthStatusSchema,
  latencyMs: z.number().finite().nonnegative(),
  errorCategory: HealthErrorCategorySchema,
});
export type ProviderRouteHealth = z.infer<typeof ProviderRouteHealthSchema>;

const ProviderRouteHealthListSchema = z
  .array(ProviderRouteHealthSchema)
  .superRefine((providers, context) => {
    const seen = new Set<ProviderFamily>();
    for (const { provider } of providers) {
      if (seen.has(provider)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate provider health record: ${provider}`,
        });
      }
      seen.add(provider);
    }
  });

export const HealthBaselineSchema = z.strictObject({
  schemaVersion: z.literal(1),
  capturedAt: TimestampSchema,
  providers: ProviderRouteHealthListSchema,
});
export type HealthBaseline = z.infer<typeof HealthBaselineSchema>;

export const NewlyUnavailableSchema = z.strictObject({
  provider: ProviderFamilySchema,
  previousStatus: HealthStatusSchema,
  currentStatus: z.union([HealthStatusSchema, z.literal('missing')]),
});
export type NewlyUnavailable = z.infer<typeof NewlyUnavailableSchema>;

export const ActualModelChangeSchema = z.strictObject({
  provider: ProviderFamilySchema,
  previousActualModel: ModelIdentifierSchema,
  currentActualModel: ModelIdentifierSchema.nullable(),
});
export type ActualModelChange = z.infer<typeof ActualModelChangeSchema>;

export const RouteChangeSchema = z.strictObject({
  provider: ProviderFamilySchema,
  previousRoute: ModelRouteSchema,
  currentRoute: ModelRouteSchema,
  previousRequestedModel: ModelIdentifierSchema,
  currentRequestedModel: ModelIdentifierSchema,
});
export type RouteChange = z.infer<typeof RouteChangeSchema>;

export const BaselineComparisonSchema = z.strictObject({
  regression: z.boolean(),
  totalOutage: z.boolean(),
  newlyUnavailable: z.array(NewlyUnavailableSchema),
  actualModelChanges: z.array(ActualModelChangeSchema),
  routeChanges: z.array(RouteChangeSchema),
});
export type BaselineComparison = z.infer<typeof BaselineComparisonSchema>;

const PROVIDER_ORDER: Record<ProviderFamily, number> = {
  anthropic: 0,
  openai: 1,
  xai: 2,
  google: 3,
  deepseek: 4,
  moonshot: 5,
};

function sanitiseModel(value: string): string {
  const sanitised = scanAndRedact(value).redacted.replace(/\s+/g, ' ').trim();
  return (sanitised || '[invalid model identity]').slice(0, 512);
}

function sanitiseRoute(route: ModelRoute): ModelRoute {
  return ModelRouteSchema.parse({
    primary: sanitiseModel(route.primary),
    fallbacks: route.fallbacks.map(sanitiseModel),
    transport: route.transport,
    ...(route.alternateTransports === undefined
      ? {}
      : { alternateTransports: route.alternateTransports }),
  });
}

function identityState(probe: ProviderProbe): ModelIdentityState {
  if (probe.status === 'healthy' && probe.actualModel !== null) return 'verified';
  if (probe.status === 'identity-unverified') return 'unverified';
  return 'unavailable';
}

function errorCategory(status: HealthStatus): HealthErrorCategory {
  switch (status) {
    case 'healthy':
      return 'none';
    case 'identity-unverified':
      return 'identity-unverified';
    case 'down':
      return 'provider-down';
    case 'unconfigured':
      return 'unconfigured';
    case 'unsafe-transport':
      return 'unsafe-transport';
  }
}

function observedRoute(probe: ProviderProbe, route: ModelRoute): ObservedRoute {
  if (probe.status === 'identity-unverified') return 'unverified';
  if (probe.status !== 'healthy' || probe.actualModel === null) return 'unavailable';
  if (probe.actualModel === route.primary) return 'primary';
  if (route.fallbacks.includes(probe.actualModel)) return 'same-provider-fallback';
  return 'outside-configured-route';
}

function routeEqual(left: ModelRoute, right: ModelRoute): boolean {
  return (
    left.primary === right.primary &&
    left.transport === right.transport &&
    left.fallbacks.length === right.fallbacks.length &&
    left.fallbacks.every((model, index) => model === right.fallbacks[index])
  );
}

function operational(status: HealthStatus): boolean {
  return status === 'healthy' || status === 'identity-unverified';
}

/** Captures a secret-free, deterministic route-health baseline. */
export function snapshot(
  probes: readonly ProviderProbe[],
  registry: ModelRegistry,
  capturedAt = new Date().toISOString(),
): HealthBaseline {
  const parsedProbes = ProviderRosterProbeSchema.parse(probes);
  const parsedRegistry = ModelRegistrySchema.parse(registry);
  const providers = parsedProbes
    .map((probe): ProviderRouteHealth => {
      const route = sanitiseRoute(parsedRegistry[probe.provider]);
      return ProviderRouteHealthSchema.parse({
        provider: probe.provider,
        route,
        observedRoute: observedRoute(probe, route),
        requestedModel: sanitiseModel(probe.requestedModel),
        actualModel: probe.actualModel === null ? null : sanitiseModel(probe.actualModel),
        identity: identityState(probe),
        status: probe.status,
        latencyMs: probe.latencyMs,
        errorCategory: errorCategory(probe.status),
      });
    })
    .sort((left, right) => PROVIDER_ORDER[left.provider] - PROVIDER_ORDER[right.provider]);

  return HealthBaselineSchema.parse({ schemaVersion: 1, capturedAt, providers });
}

/** Compares current health against the last-known route and model identity. */
export function compareBaseline(
  baseline: HealthBaseline,
  current: HealthBaseline,
): BaselineComparison {
  const parsedBaseline = HealthBaselineSchema.parse(baseline);
  const parsedCurrent = HealthBaselineSchema.parse(current);
  const previousByProvider = new Map(
    parsedBaseline.providers.map((provider) => [provider.provider, provider] as const),
  );
  const currentByProvider = new Map(
    parsedCurrent.providers.map((provider) => [provider.provider, provider] as const),
  );
  const newlyUnavailable: NewlyUnavailable[] = [];
  const actualModelChanges: ActualModelChange[] = [];
  const routeChanges: RouteChange[] = [];

  for (const previous of parsedBaseline.providers) {
    const next = currentByProvider.get(previous.provider);
    if (operational(previous.status) && (next === undefined || !operational(next.status))) {
      newlyUnavailable.push({
        provider: previous.provider,
        previousStatus: previous.status,
        currentStatus: next?.status ?? 'missing',
      });
    }
    if (next === undefined) continue;

    if (
      operational(previous.status) &&
      operational(next.status) &&
      previous.actualModel !== null &&
      previous.actualModel !== next.actualModel
    ) {
      actualModelChanges.push({
        provider: previous.provider,
        previousActualModel: sanitiseModel(previous.actualModel),
        currentActualModel: next.actualModel === null ? null : sanitiseModel(next.actualModel),
      });
    }

    if (
      !routeEqual(previous.route, next.route) ||
      previous.requestedModel !== next.requestedModel
    ) {
      routeChanges.push({
        provider: previous.provider,
        previousRoute: sanitiseRoute(previous.route),
        currentRoute: sanitiseRoute(next.route),
        previousRequestedModel: sanitiseModel(previous.requestedModel),
        currentRequestedModel: sanitiseModel(next.requestedModel),
      });
    }
  }

  const roster = new Set<ProviderFamily>([
    ...previousByProvider.keys(),
    ...currentByProvider.keys(),
  ]);
  const totalOutage =
    roster.size > 0 &&
    [...roster].every((provider) => {
      const health = currentByProvider.get(provider);
      return health === undefined || !operational(health.status);
    });
  const regression =
    totalOutage ||
    newlyUnavailable.length > 0 ||
    actualModelChanges.length > 0 ||
    routeChanges.length > 0;

  return BaselineComparisonSchema.parse({
    regression,
    totalOutage,
    newlyUnavailable,
    actualModelChanges,
    routeChanges,
  });
}
