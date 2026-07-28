import { z } from 'zod';
import { ModelRouteSchema, type ModelRoute } from '../domain/schemas';
import shippedRegistry from './registry.json';

export const ModelRegistrySchema = z.strictObject({
  anthropic: ModelRouteSchema,
  openai: ModelRouteSchema,
  xai: ModelRouteSchema,
  google: ModelRouteSchema,
  deepseek: ModelRouteSchema,
  moonshot: ModelRouteSchema,
});
export type ModelRegistry = z.infer<typeof ModelRegistrySchema>;

const RegistryOverrideSchema = z.record(z.string(), z.unknown());
const ModelRouteOverrideSchema = z.strictObject({
  primary: ModelRouteSchema.shape.primary.optional(),
  fallbacks: ModelRouteSchema.shape.fallbacks.optional(),
  transport: ModelRouteSchema.shape.transport.optional(),
});

function mergeRoute(base: ModelRoute, override: unknown): ModelRoute {
  if (override === undefined) return base;

  const parsedOverride = ModelRouteOverrideSchema.parse(override);
  return ModelRouteSchema.parse({ ...base, ...parsedOverride });
}

export async function loadModelRegistry(overridePath?: string): Promise<ModelRegistry> {
  const base = ModelRegistrySchema.parse(shippedRegistry);
  if (overridePath === undefined) return base;

  const override = RegistryOverrideSchema.parse(await Bun.file(overridePath).json());
  const merged = {
    anthropic: mergeRoute(base.anthropic, override.anthropic),
    openai: mergeRoute(base.openai, override.openai),
    xai: mergeRoute(base.xai, override.xai),
    google: mergeRoute(base.google, override.google),
    deepseek: mergeRoute(base.deepseek, override.deepseek),
    moonshot: mergeRoute(base.moonshot, override.moonshot),
  };

  return ModelRegistrySchema.parse(merged);
}
