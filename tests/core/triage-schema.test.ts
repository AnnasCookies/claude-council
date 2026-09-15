import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  BUILT_IN_TRIAGE_SCHEMA_NAMES,
  HUMAN_ROUTE,
  builtInTriageSchema,
  loadTriageSchemaFile,
  parseTriageSchema,
  triageAnswerInstruction,
  triageAnswerJsonSchema,
  triageVerdictSchema,
} from '../../src/modes/triage/schema';

describe('declared triage schemas', () => {
  test('the built-in pr-comment schema is the one docs/modes.md declares', () => {
    expect(builtInTriageSchema('pr-comment')).toEqual({
      name: 'pr-comment',
      classes: ['bug', 'style', 'question', 'nit', 'praise', 'security'],
      severities: ['low', 'medium', 'high'],
      routes: ['fix', 'discuss', 'ignore', 'human'],
    });
    expect([...BUILT_IN_TRIAGE_SCHEMA_NAMES]).toEqual(['pr-comment']);
  });

  test('every caller gets its own copy of the built-in schema', () => {
    const first = builtInTriageSchema('pr-comment');
    first.classes.push('invented');
    expect(builtInTriageSchema('pr-comment').classes).not.toContain('invented');
  });

  test('an unknown built-in name names the built-ins and points at --schema-file', () => {
    expect(() => builtInTriageSchema('issue')).toThrow(/Unknown triage schema: issue/);
    expect(() => builtInTriageSchema('issue')).toThrow(/pr-comment/);
    expect(() => builtInTriageSchema('issue')).toThrow(/--schema-file/);
  });

  test('a declared schema must be non-empty, unique and lower-case', () => {
    const valid = { name: 'issue', classes: ['bug'], severities: ['low'], routes: ['fix'] };
    expect(parseTriageSchema(valid).name).toBe('issue');
    expect(() => parseTriageSchema({ ...valid, classes: [] })).toThrow();
    expect(() => parseTriageSchema({ ...valid, classes: ['bug', 'bug'] })).toThrow(
      /Duplicate classes term: bug/,
    );
    expect(() => parseTriageSchema({ ...valid, severities: ['Low'] })).toThrow();
    expect(() => parseTriageSchema({ ...valid, routes: ['needs review'] })).toThrow();
    expect(() => parseTriageSchema({ ...valid, name: '' })).toThrow();
    expect(() => parseTriageSchema({ ...valid, extra: true })).toThrow();
    expect(() => parseTriageSchema('pr-comment')).toThrow();
  });

  test('human is always a route, added once and never reordered', () => {
    expect(
      parseTriageSchema({ name: 'issue', classes: ['bug'], severities: ['low'], routes: ['fix'] })
        .routes,
    ).toEqual(['fix', HUMAN_ROUTE]);
    expect(
      parseTriageSchema({
        name: 'issue',
        classes: ['bug'],
        severities: ['low'],
        routes: ['human', 'fix'],
      }).routes,
    ).toEqual(['human', 'fix']);
  });

  test('a verdict validates against the declared terms and nothing else', () => {
    const verdict = triageVerdictSchema(builtInTriageSchema('pr-comment'));
    expect(
      verdict.parse({
        class: 'bug',
        severity: 'high',
        route: 'fix',
        confidence: 0.8,
        reason: '  breaks the build  ',
      }),
    ).toEqual({
      class: 'bug',
      severity: 'high',
      route: 'fix',
      confidence: 0.8,
      reason: 'breaks the build',
    });
    const invalid = verdict.safeParse({
      class: 'blocker',
      severity: 'high',
      route: 'fix',
      confidence: 0.8,
      reason: 'x',
    });
    expect(invalid.success).toBe(false);
    if (invalid.success) throw new Error('unreachable');
    expect(invalid.error.issues[0]?.message).toContain(
      'must be one of: bug, style, question, nit, praise, security',
    );
    const cases = [
      { class: 'bug', severity: 'critical', route: 'fix', confidence: 0.8, reason: 'x' },
      { class: 'bug', severity: 'high', route: 'escalate', confidence: 0.8, reason: 'x' },
      { class: 'bug', severity: 'high', route: 'fix', confidence: 1.5, reason: 'x' },
      { class: 'bug', severity: 'high', route: 'fix', confidence: -0.1, reason: 'x' },
      { class: 'bug', severity: 'high', route: 'fix', confidence: 0.5, reason: '   ' },
      { class: 'bug', severity: 'high', route: 'fix', confidence: 0.5, reason: 'x', extra: 1 },
    ];
    for (const value of cases) expect(verdict.safeParse(value).success).toBe(false);
  });

  test('the wire contract names every declared term', () => {
    const declared = parseTriageSchema({
      name: 'issue',
      classes: ['bug', 'chore'],
      severities: ['low'],
      routes: ['fix'],
    });
    expect(triageAnswerJsonSchema(declared)).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['class', 'severity', 'route', 'confidence', 'reason'],
      properties: {
        class: { type: 'string', enum: ['bug', 'chore'] },
        severity: { type: 'string', enum: ['low'] },
        route: { type: 'string', enum: ['fix', 'human'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reason: { type: 'string', minLength: 1, maxLength: 400 },
      },
    });
    const instruction = triageAnswerInstruction(declared);
    expect(instruction).toContain('bug, chore');
    expect(instruction).toContain('fix, human');
    expect(instruction).toContain('confidence (number from 0 to 1)');
    expect(instruction).toContain('Do not wrap it in prose.');
  });

  test('a schema file is read and validated, and a broken one names its path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'convene-triage-schema-'));
    try {
      const good = join(root, 'issue.json');
      await writeFile(
        good,
        JSON.stringify({ name: 'issue', classes: ['bug'], severities: ['low'], routes: ['fix'] }),
        'utf8',
      );
      expect((await loadTriageSchemaFile(good)).routes).toEqual(['fix', 'human']);

      const broken = join(root, 'broken.json');
      await writeFile(broken, '{ not json', 'utf8');
      await expect(loadTriageSchemaFile(broken)).rejects.toThrow(
        /Unable to read triage schema file/,
      );

      const wrong = join(root, 'wrong.json');
      await writeFile(
        wrong,
        JSON.stringify({ name: 'issue', classes: [], severities: ['low'], routes: ['fix'] }),
        'utf8',
      );
      await expect(loadTriageSchemaFile(wrong)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
