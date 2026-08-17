import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import packageManifest from '../../package.json';
import { runCliFacade, type CliFacadeResult } from '../../src/cli';

const CliOutputSchema = z.record(z.string(), z.unknown());
const SelfCheckOutputSchema = z.looseObject({
  routes: z.looseObject({
    xai: z.looseObject({
      primary: z.string(),
      alternateTransports: z.array(z.string()),
    }),
  }),
  registryProvenance: z.unknown(),
  transportResolutions: z.looseObject({
    xai: z.strictObject({
      preferred: z.string(),
      effective: z.string().nullable(),
      reason: z.string(),
    }),
  }),
});
const RunOutputSchema = z.looseObject({
  manifest: z.looseObject({
    routes: z.looseObject({
      xai: z.looseObject({
        primary: z.string(),
        alternateTransports: z.array(z.string()),
      }),
    }),
    registryProvenance: z.unknown(),
  }),
});
const DoctorOutputSchema = z.looseObject({
  engineIdentity: z.record(z.string(), z.unknown()),
});

function parseOutput(result: CliFacadeResult) {
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe('');
  return CliOutputSchema.parse(JSON.parse(result.stdout));
}

async function withIsolatedHome<T>(
  assertion: (fixture: { directory: string; home: string }) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-council-version-'));
  const home = join(directory, 'home');
  await mkdir(home, { recursive: true });
  try {
    return await assertion({ directory, home });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('engine version identity', () => {
  test('reports the running engine identity without inventing installer provenance', async () => {
    await withIsolatedHome(async ({ directory, home }) => {
      const output = parseOutput(
        await runCliFacade(['version', '--json', '--records-root', 'records'], {
          cwd: directory,
          env: { HOME: home },
        }),
      );
      const executablePath = output.executablePath;
      if (typeof executablePath !== 'string') throw new Error('executablePath must be a string');

      expect(output).toMatchObject({
        executablePath: expect.any(String),
        packageVersion: packageManifest.version,
        stateRoot: resolve(directory, 'records'),
        routes: {
          xai: {
            alternateTransports: ['http'],
          },
        },
        registryProvenance: {
          kind: 'built-in-only',
          routes: {
            anthropic: 'built-in',
            openai: 'built-in',
            xai: 'built-in',
            google: 'built-in',
            deepseek: 'built-in',
            moonshot: 'built-in',
          },
        },
        adapterContractVersion: 1,
        installerProvenance: null,
        reason: expect.stringContaining('not supplied'),
      });
      expect(isAbsolute(executablePath)).toBe(true);
      expect(output).not.toHaveProperty('sourceCommitSha');
    });
  });

  test('labels optional provenance as installer-supplied rather than self-attested', async () => {
    await withIsolatedHome(async ({ directory, home }) => {
      const output = parseOutput(
        await runCliFacade(['version', '--json'], {
          cwd: directory,
          env: {
            HOME: home,
            COUNCIL_INSTALLER_PROVENANCE: 'claude-marketplace/2026.8.14 cache=stable',
          },
        }),
      );

      expect(output.installerProvenance).toEqual({
        value: 'claude-marketplace/2026.8.14 cache=stable',
        source: 'installer-supplied',
        selfAttested: false,
      });
      expect(output).not.toHaveProperty('reason');
    });
  });

  test('--registry overrides the records-root default and reports its exact SHA-256', async () => {
    await withIsolatedHome(async ({ directory, home }) => {
      const recordsRoot = join(directory, 'records');
      const explicitPath = join(directory, 'explicit-models.json');
      const explicitContents =
        '{"xai":{"primary":"explicit-grok","transport":"subscription-cli","alternateTransports":["http"]}}\n';
      await mkdir(recordsRoot, { recursive: true });
      await Bun.write(join(recordsRoot, 'models.json'), '{"xai":{"primary":"records-grok"}}');
      await Bun.write(explicitPath, explicitContents);

      const output = parseOutput(
        await runCliFacade(
          ['self-check', '--json', '--records-root', recordsRoot, '--registry', explicitPath],
          { cwd: directory, env: { HOME: home, COUNCIL_XAI_API_KEY: 'test-key' } },
        ),
      );
      const selfCheck = SelfCheckOutputSchema.parse(output);

      expect(selfCheck.routes.xai.primary).toBe('explicit-grok');
      expect(selfCheck.registryProvenance).toMatchObject({
        kind: 'override',
        overridePath: resolve(explicitPath),
        overrideSha256: createHash('sha256').update(explicitContents).digest('hex'),
        routes: { xai: 'override', anthropic: 'built-in' },
      });
      expect(selfCheck.routes.xai.alternateTransports).toEqual(['http']);
      expect(selfCheck.transportResolutions.xai).toEqual({
        preferred: 'subscription-cli',
        effective: 'http',
        reason:
          'No grok subscription CLI resolved on PATH; fell back to the metered COUNCIL_XAI_API_KEY. This call is billable.',
      });
    });
  });

  test('puts route provenance in the run manifest', async () => {
    await withIsolatedHome(async ({ directory, home }) => {
      const overridePath = join(directory, 'models.json');
      const overrideContents = '{"xai":{"primary":"grok-5"}}';
      await Bun.write(overridePath, overrideContents);

      const output = parseOutput(
        await runCliFacade(
          [
            'run',
            '--dry-run',
            '--motion',
            'Choose a registry update strategy.',
            '--registry',
            overridePath,
          ],
          { cwd: directory, env: { HOME: home }, now: () => '2026-08-14T12:00:00.000Z' },
        ),
      );
      const manifest = RunOutputSchema.parse(output).manifest;

      expect(manifest.routes.xai.primary).toBe('grok-5');
      expect(manifest.registryProvenance).toMatchObject({
        kind: 'override',
        overridePath: resolve(overridePath),
        overrideSha256: createHash('sha256').update(overrideContents).digest('hex'),
        routes: { xai: 'override' },
      });
      expect(manifest.routes.xai.alternateTransports).toEqual(['http']);
    });
  });

  test('adds the same engine identity to doctor JSON output', async () => {
    await withIsolatedHome(async ({ directory, home }) => {
      const overridePath = join(directory, 'models.json');
      await Bun.write(overridePath, '{"xai":{"primary":"grok-5"}}');

      const output = parseOutput(
        await runCliFacade(['doctor', '--json', '--registry', overridePath], {
          adapters: {},
          cwd: directory,
          env: { HOME: home },
        }),
      );
      const engineIdentity = DoctorOutputSchema.parse(output).engineIdentity;

      expect(engineIdentity).toMatchObject({
        executablePath: expect.any(String),
        packageVersion: packageManifest.version,
        stateRoot: null,
        routes: {
          xai: {
            alternateTransports: ['http'],
          },
        },
        registryProvenance: {
          kind: 'override',
          overridePath: resolve(overridePath),
          routes: { xai: 'override' },
        },
        adapterContractVersion: 1,
        installerProvenance: null,
        reason: expect.stringContaining('not supplied'),
      });
    });
  });
});
