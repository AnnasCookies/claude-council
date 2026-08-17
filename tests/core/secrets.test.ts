import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { scanAndRedact, type SecretKind } from '../../src/policy/secrets';

function fingerprint(kind: SecretKind, value: string): string {
  return createHash('sha256')
    .update(kind + value)
    .digest('hex')
    .slice(0, 8);
}

function expectSecretRedacted(text: string, value: string, expectedKind: SecretKind): void {
  const result = scanAndRedact(text);
  const serialised = JSON.stringify(result);

  expect(result.hardBlocked).toBe(true);
  expect(result.redacted.includes(value)).toBe(false);
  expect(serialised.includes(value)).toBe(false);
  expect(result.findings).toHaveLength(1);

  const finding = result.findings[0];
  expect(finding).toBeDefined();
  if (finding === undefined) return;

  const replacement = `<SECRET:${expectedKind}:${fingerprint(expectedKind, value)}>`;
  expect(finding).toEqual({
    kind: expectedKind,
    start: text.indexOf(value),
    end: text.indexOf(value) + value.length,
    confidence: 'high',
    replacement,
  });
  expect(result.redacted.includes(replacement)).toBe(true);
  expect(Object.keys(finding).sort()).toEqual([
    'confidence',
    'end',
    'kind',
    'replacement',
    'start',
  ]);
}

describe('secret scanning and redaction', () => {
  test('redacts the plan OpenAI fixture with the specified deterministic fingerprint', () => {
    const value = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
    const result = scanAndRedact(`token=${value}`);

    expect(result.hardBlocked).toBe(true);
    expect(result.redacted).toBe('token=<SECRET:OPENAI:5991e7b5>');
    expect(result.redacted.includes(value)).toBe(false);
    expect(JSON.stringify(result.findings).includes(value)).toBe(false);
  });

  test('recognises each high-confidence secret class', () => {
    const privateKey = [
      ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
      'cHJpdmF0ZS1rZXktbWF0ZXJpYWw=',
      ['-----END', 'PRIVATE KEY-----'].join(' '),
    ].join('\n');
    const bearer = 'opaque-bearer-token-0123456789';
    const sessionCookie = `s%3A${'c'.repeat(36)}`;
    const credentialUrl = 'postgresql://app_user:database-password@db.example.test/council';
    const password = 'configuration-password-0123456789';

    expectSecretRedacted(`key = "${privateKey}"`, privateKey, 'PEM_PRIVATE_KEY');
    expectSecretRedacted(`Authorization: Bearer ${bearer}`, bearer, 'BEARER_TOKEN');
    expectSecretRedacted(
      `Cookie: sessionid=${sessionCookie}; Path=/`,
      sessionCookie,
      'SESSION_COOKIE',
    );
    expectSecretRedacted(`DATABASE_URL=${credentialUrl}`, credentialUrl, 'CREDENTIAL_URL');
    expectSecretRedacted(`database_password = "${password}"`, password, 'PASSWORD');
  });

  test('recognises password literals across JSON, YAML and container configuration', () => {
    const configurationCases = [
      {
        text: `{"database":{"password":"${'j'.repeat(32)}"}}`,
        value: 'j'.repeat(32),
      },
      {
        text: `database_password: '${'y'.repeat(32)}'`,
        value: 'y'.repeat(32),
      },
      {
        text: `environment:\n  - DB_PASSWORD=${'d'.repeat(32)}`,
        value: 'd'.repeat(32),
      },
    ] as const;

    for (const configurationCase of configurationCases) {
      expectSecretRedacted(configurationCase.text, configurationCase.value, 'PASSWORD');
    }
  });

  test('recognises supported provider key formats and provider-labelled configuration values', () => {
    const providerCases: ReadonlyArray<{
      kind: SecretKind;
      value: string;
      text: (value: string) => string;
    }> = [
      {
        kind: 'ANTHROPIC',
        value: `sk-ant-api03-${'a'.repeat(40)}`,
        text: (value) => `token=${value}`,
      },
      {
        kind: 'OPENAI',
        value: `sk-svcacct-${'o'.repeat(40)}`,
        text: (value) => `token=${value}`,
      },
      {
        kind: 'XAI',
        value: `xai-${'x'.repeat(40)}`,
        text: (value) => `token=${value}`,
      },
      {
        kind: 'GOOGLE',
        value: `AIza${'g'.repeat(35)}`,
        text: (value) => `token=${value}`,
      },
      {
        kind: 'DEEPSEEK',
        value: `sk-${'d'.repeat(48)}`,
        text: (value) => `COUNCIL_DEEPSEEK_API_KEY="${value}"`,
      },
      {
        kind: 'MOONSHOT',
        value: `sk-${'m'.repeat(48)}`,
        text: (value) => `COUNCIL_MOONSHOT_API_KEY: '${value}'`,
      },
    ];

    for (const providerCase of providerCases) {
      expectSecretRedacted(
        providerCase.text(providerCase.value),
        providerCase.value,
        providerCase.kind,
      );
    }
  });

  test('detects both bare vendor credential names and the council-prefixed forms', () => {
    // The council authenticates only with COUNCIL_-prefixed names, but the outbound scanner must
    // keep catching the bare vendor names: those are the forms that leak into pasted evidence,
    // .env excerpts and shell transcripts, and they are what other tooling would claim and spend.
    const bare = `sk-${'b'.repeat(48)}`;
    expectSecretRedacted(`DEEPSEEK_API_KEY="${bare}"`, bare, 'DEEPSEEK');

    const prefixed = `sk-${'p'.repeat(48)}`;
    expectSecretRedacted(`COUNCIL_DEEPSEEK_API_KEY="${prefixed}"`, prefixed, 'DEEPSEEK');

    const exported = `xai-${'e'.repeat(40)}`;
    expectSecretRedacted(`export COUNCIL_XAI_API_KEY=${exported}`, exported, 'XAI');

    const anthropic = `sk-ant-${'a'.repeat(40)}`;
    expectSecretRedacted(`ANTHROPIC_API_KEY=${anthropic}`, anthropic, 'ANTHROPIC');
  });

  test('resolves overlapping detections once and keeps the most specific provider kind', () => {
    const value = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
    const result = scanAndRedact(`Authorization: Bearer ${value}`);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe('OPENAI');
    expect(result.redacted.match(/<SECRET:/g)).toHaveLength(1);
    expect(JSON.stringify(result).includes(value)).toBe(false);
  });

  test('uses one stable replacement for repeated occurrences without retaining the value', () => {
    const value = `xai-${'q'.repeat(40)}`;
    const result = scanAndRedact(`${value}\n${value}`);
    const expectedReplacement = `<SECRET:XAI:${fingerprint('XAI', value)}>`;

    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((finding) => finding.replacement === expectedReplacement)).toBe(
      true,
    );
    expect(result.redacted).toBe(`${expectedReplacement}\n${expectedReplacement}`);
    expect(JSON.stringify(result).includes(value)).toBe(false);
  });

  test('leaves ordinary prose and non-credential URLs unchanged', () => {
    const text = [
      'Use bearer capacity planning for the public architecture.',
      'Documentation: https://example.test/council',
      'The password policy requires twelve characters.',
    ].join('\n');

    expect(scanAndRedact(text)).toEqual({
      redacted: text,
      findings: [],
      hardBlocked: false,
    });
  });
});
