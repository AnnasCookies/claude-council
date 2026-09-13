import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  ModelRegistryProvenanceSchema,
  ModelRouteSchema,
  type ModelRegistryProvenance,
  type ModelRoute,
} from '../domain/schemas';
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

const ModelRouteOverrideSchema = ModelRouteSchema.partial();
const ModelRegistryOverrideSchema = z.strictObject({
  anthropic: ModelRouteOverrideSchema.optional(),
  openai: ModelRouteOverrideSchema.optional(),
  xai: ModelRouteOverrideSchema.optional(),
  google: ModelRouteOverrideSchema.optional(),
  deepseek: ModelRouteOverrideSchema.optional(),
  moonshot: ModelRouteOverrideSchema.optional(),
});
type ModelRegistryOverride = z.infer<typeof ModelRegistryOverrideSchema>;

export interface LoadedModelRegistry {
  readonly registry: ModelRegistry;
  readonly provenance: ModelRegistryProvenance;
}

export interface ModelRegistryResolutionOptions {
  readonly overridePath?: string;
  readonly recordsRoot?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const BUILT_IN_ROUTE_SOURCES = {
  anthropic: 'built-in',
  openai: 'built-in',
  xai: 'built-in',
  google: 'built-in',
  deepseek: 'built-in',
  moonshot: 'built-in',
} as const;

function mergeRoute(base: ModelRoute, override: unknown): ModelRoute {
  if (override === undefined) return base;

  const parsedOverride = ModelRouteOverrideSchema.parse(override);
  return ModelRouteSchema.parse({ ...base, ...parsedOverride });
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length === 0 ? '<root>' : issue.path.join('.');
      if (issue.code === 'unrecognized_keys') {
        const pluralSuffix = issue.keys.length === 1 ? '' : 's';
        return `${location}: unknown key${pluralSuffix} ${issue.keys.join(', ')}`;
      }
      return `${location}: ${issue.message}`;
    })
    .join('; ');
}

function mergedRegistry(base: ModelRegistry, override: ModelRegistryOverride): ModelRegistry {
  return ModelRegistrySchema.parse({
    anthropic: mergeRoute(base.anthropic, override.anthropic),
    openai: mergeRoute(base.openai, override.openai),
    xai: mergeRoute(base.xai, override.xai),
    google: mergeRoute(base.google, override.google),
    deepseek: mergeRoute(base.deepseek, override.deepseek),
    moonshot: mergeRoute(base.moonshot, override.moonshot),
  });
}

function routeSources(override: ModelRegistryOverride) {
  return {
    anthropic: override.anthropic === undefined ? 'built-in' : 'override',
    openai: override.openai === undefined ? 'built-in' : 'override',
    xai: override.xai === undefined ? 'built-in' : 'override',
    google: override.google === undefined ? 'built-in' : 'override',
    deepseek: override.deepseek === undefined ? 'built-in' : 'override',
    moonshot: override.moonshot === undefined ? 'built-in' : 'override',
  } as const;
}

function builtInRegistry(): LoadedModelRegistry {
  return {
    registry: ModelRegistrySchema.parse(shippedRegistry),
    provenance: ModelRegistryProvenanceSchema.parse({
      kind: 'built-in-only',
      routes: BUILT_IN_ROUTE_SOURCES,
    }),
  };
}

export async function loadModelRegistryWithProvenance(
  overridePath?: string,
): Promise<LoadedModelRegistry> {
  const builtIn = builtInRegistry();
  if (overridePath === undefined) return builtIn;

  const absolutePath = resolve(overridePath);
  let contents: string;
  let fileBytes: Uint8Array;
  try {
    fileBytes = new Uint8Array(await Bun.file(absolutePath).arrayBuffer());
    contents = new TextDecoder('utf-8', { fatal: true }).decode(fileBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read model registry override "${absolutePath}": ${message}`, {
      cause: error,
    });
  }

  let rawOverride: unknown;
  try {
    rawOverride = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid model registry override "${absolutePath}": malformed JSON: ${message}`,
      { cause: error },
    );
  }

  let override: ModelRegistryOverride;
  try {
    override = ModelRegistryOverrideSchema.parse(rawOverride);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `Invalid model registry override "${absolutePath}": ${validationMessage(error)}`,
        { cause: error },
      );
    }
    throw error;
  }

  let registry: ModelRegistry;
  try {
    registry = mergedRegistry(builtIn.registry, override);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `Invalid model registry override "${absolutePath}": ${validationMessage(error)}`,
        { cause: error },
      );
    }
    throw error;
  }

  return {
    registry,
    provenance: ModelRegistryProvenanceSchema.parse({
      kind: 'override',
      overridePath: absolutePath,
      overrideSha256: createHash('sha256').update(fileBytes).digest('hex'),
      routes: routeSources(override),
    }),
  };
}

export async function loadModelRegistry(overridePath?: string): Promise<ModelRegistry> {
  return (await loadModelRegistryWithProvenance(overridePath)).registry;
}

/**
 * Resolves registry precedence as explicit override, records-root override,
 * user-level override, then the built-in registry.
 */
export async function resolveModelRegistry(
  options: ModelRegistryResolutionOptions = {},
): Promise<LoadedModelRegistry> {
  const cwd = resolve(options.cwd ?? process.cwd());
  if (options.overridePath !== undefined) {
    const explicitPath = isAbsolute(options.overridePath)
      ? options.overridePath
      : resolve(cwd, options.overridePath);
    return loadModelRegistryWithProvenance(explicitPath);
  }

  if (options.recordsRoot !== undefined) {
    const recordsRoot = isAbsolute(options.recordsRoot)
      ? options.recordsRoot
      : resolve(cwd, options.recordsRoot);
    const recordsRegistryPath = join(recordsRoot, 'models.json');
    if (await Bun.file(recordsRegistryPath).exists()) {
      return loadModelRegistryWithProvenance(recordsRegistryPath);
    }
  }

  const environment = options.env ?? process.env;
  const configuredHome = environment.HOME?.trim() || environment.USERPROFILE?.trim();
  const homeValue = configuredHome || homedir();
  const home = isAbsolute(homeValue) ? resolve(homeValue) : resolve(cwd, homeValue);
  const userRegistryPath = join(home, '.claude', 'council', 'models.json');
  if (await Bun.file(userRegistryPath).exists()) {
    return loadModelRegistryWithProvenance(userRegistryPath);
  }

  return builtInRegistry();
}
