import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  canonicaliseRemote,
  projectIdFromRemote,
  resolveProjectIdentity,
} from '../../src/records/project-id';

setDefaultTimeout(15_000);

describe('project identity', () => {
  test('canonicalises equivalent SSH and HTTPS remotes to one identity', () => {
    const ssh = canonicaliseRemote('git@GitHub.COM:Example-Org\\council-kernel.git');
    const sshUrl = canonicaliseRemote('ssh://git@github.com/Example-Org/council-kernel.git');
    const https = canonicaliseRemote(
      'https://build-user:discard-me@github.com//Example-Org/council-kernel.git/',
    );

    expect(ssh).toBe('github.com/Example-Org/council-kernel');
    expect(sshUrl).toBe(ssh);
    expect(https).toBe(ssh);
    expect(projectIdFromRemote(ssh)).toBe(projectIdFromRemote(https));
    expect(projectIdFromRemote(ssh)).toContain('github-com-example-org-council-kernel');
  });

  test('hashes the host as part of the canonical remote identity', () => {
    const github = projectIdFromRemote('https://github.com/example/shared-name.git');
    const gitlab = projectIdFromRemote('https://gitlab.com/example/shared-name.git');

    expect(github).not.toBe(gitlab);
    expect(github).toMatch(/^github-com-example-shared-name-[a-f0-9]{12}$/);
    expect(gitlab).toMatch(/^gitlab-com-example-shared-name-[a-f0-9]{12}$/);
  });

  test('uses a visible root slug and stable short path hash when no remote exists', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'council-project-id-'));
    const projectRoot = join(fixtureRoot, 'Visible Council');
    await mkdir(projectRoot);
    const otherProjectRoot = join(fixtureRoot, 'nested', 'Visible Council');
    await mkdir(otherProjectRoot, { recursive: true });

    try {
      const first = await resolveProjectIdentity(projectRoot);
      const second = await resolveProjectIdentity(`${projectRoot}/`);
      const other = await resolveProjectIdentity(otherProjectRoot);

      expect(first.source).toBe('path');
      expect(first.projectId).toBe(second.projectId);
      expect(first.projectId).toMatch(/^visible-council-[a-f0-9]{12}$/);
      expect(first.displayName).toBe('Visible Council');
      expect(other.projectId).not.toBe(first.projectId);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
