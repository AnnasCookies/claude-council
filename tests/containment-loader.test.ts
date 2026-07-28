import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

setDefaultTimeout(30_000);

const projectRoot = resolve(import.meta.dir, '..');
const temporaryRoots: string[] = [];

function writeProviderFixtures(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  for (const provider of ['agy', 'codex', 'curl', 'gemini', 'grok']) {
    const path = join(binDir, `${provider}${process.platform === 'win32' ? '.cmd' : ''}`);
    const script =
      process.platform === 'win32'
        ? `@echo off\r\n>>"%COUNCIL_PROVIDER_REQUEST_LOG%" echo ${provider}\r\nexit /b 0\r\n`
        : `#!/bin/sh\nprintf '%s\\n' '${provider}' >> "$COUNCIL_PROVIDER_REQUEST_LOG"\n`;
    writeFileSync(path, script, 'utf8');
    if (process.platform !== 'win32') chmodSync(path, 0o755);
  }
}

async function waitForPluginLoadAndObserve(
  debugLog: string,
  providerLog: string,
  exited: Promise<number>,
): Promise<void> {
  let processExited = false;
  void exited.then(() => {
    processExited = true;
  });
  const loadDeadline = Date.now() + 25_000;
  while (!processExited && Date.now() < loadDeadline) {
    if (readFileSync(providerLog, 'utf8') !== '') {
      throw new Error('Council provider request occurred while the plugin was loading');
    }
    if (
      existsSync(debugLog) &&
      /Loaded 5 commands from plugin claude-council/.test(readFileSync(debugLog, 'utf8'))
    ) {
      const observationDeadline = Date.now() + 2_000;
      while (!processExited && Date.now() < observationDeadline) {
        if (readFileSync(providerLog, 'utf8') !== '') {
          throw new Error('Council provider request occurred after the plugin loaded');
        }
        await Bun.sleep(100);
      }
      return;
    }
    await Bun.sleep(100);
  }
  if (!processExited) {
    throw new Error('Claude did not load the council plugin before the containment deadline');
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('[AC-SEC-001] the real Claude plugin loader makes no council provider request', async () => {
  expect(Bun.which('claude')).not.toBeNull();

  const root = mkdtempSync(join(tmpdir(), 'claude-council-containment-'));
  temporaryRoots.push(root);
  const home = join(root, 'home');
  const binDir = join(root, 'bin');
  const debugLog = join(root, 'claude-debug.log');
  const providerLog = join(root, 'provider-requests.log');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(providerLog, '', 'utf8');
  writeProviderFixtures(binDir);

  const environment = { ...process.env };
  for (const key of [
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'GEMINI_API_KEY',
    'GROK_API_KEY',
    'OPENAI_API_KEY',
    'PERPLEXITY_API_KEY',
    'XAI_API_KEY',
  ]) {
    delete environment[key];
  }
  environment.ANTHROPIC_API_KEY = '';
  environment.CLAUDE_CONFIG_DIR = join(home, '.claude');
  environment.COUNCIL_PROVIDER_REQUEST_LOG = providerLog;
  environment.HOME = home;
  environment.USERPROFILE = home;
  environment.PATH = `${binDir}${delimiter}${process.env.PATH ?? ''}`;

  const child = Bun.spawn(
    [
      'claude',
      '--plugin-dir',
      projectRoot,
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--tools',
      '',
      '--no-session-persistence',
      '--debug-file',
      debugLog,
      '--print',
      'plugin load probe',
    ],
    { cwd: projectRoot, env: environment, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  try {
    await waitForPluginLoadAndObserve(debugLog, providerLog, child.exited);
  } finally {
    child.kill();
  }
  const [, , exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(exitCode).not.toBe(0);
  expect(existsSync(debugLog)).toBe(true);
  const debug = readFileSync(debugLog, 'utf8');
  expect(debug).toMatch(/Loaded inline plugin from path: claude-council/);
  expect(debug).toMatch(/Loaded 5 commands from plugin claude-council/);
  expect(readFileSync(providerLog, 'utf8')).toBe('');
});
