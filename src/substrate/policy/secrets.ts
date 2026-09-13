import { createHash } from 'node:crypto';
import { z } from 'zod';

export const SECRET_KINDS = [
  'PEM_PRIVATE_KEY',
  'BEARER_TOKEN',
  'ANTHROPIC',
  'OPENAI',
  'XAI',
  'GOOGLE',
  'DEEPSEEK',
  'MOONSHOT',
  'SESSION_COOKIE',
  'CREDENTIAL_URL',
  'PASSWORD',
] as const;

export const SecretKindSchema = z.enum(SECRET_KINDS);
export type SecretKind = z.infer<typeof SecretKindSchema>;

export const SecretConfidenceSchema = z.literal('high');
export type SecretConfidence = z.infer<typeof SecretConfidenceSchema>;

export const SecretFindingSchema = z.strictObject({
  kind: SecretKindSchema,
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  confidence: SecretConfidenceSchema,
  replacement: z.string().regex(/^<SECRET:[A-Z_]+:[a-f0-9]{8}>$/),
});
export type SecretFinding = z.infer<typeof SecretFindingSchema>;

export const RedactionResultSchema = z.strictObject({
  redacted: z.string(),
  findings: z.array(SecretFindingSchema),
  hardBlocked: z.boolean(),
});
export type RedactionResult = z.infer<typeof RedactionResultSchema>;

interface Candidate {
  readonly kind: SecretKind;
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly priority: number;
}

interface PatternDetector {
  readonly kind: SecretKind;
  readonly pattern: RegExp;
  readonly priority: number;
  readonly extractValue: (match: RegExpExecArray) => string | undefined;
}

// Detection, not authentication. This must keep matching the BARE vendor names because those are
// the forms most likely to leak into pasted evidence, and it must also match the council's own
// `COUNCIL_`-prefixed names. The prefix is non-capturing so the captured group stays the bare name
// and the kind mapping below is unaffected.
const PROVIDER_ASSIGNMENT_PATTERN =
  /(?:^|[\r\n,{])[ \t]*(?:-[ \t]+)?(?:export[ \t]+)?["']?(?:COUNCIL_)?(ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|GEMINI_API_KEY|DEEPSEEK_API_KEY|MOONSHOT_API_KEY|KIMI_API_KEY)["']?[ \t]*(?:=|:)[ \t]*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#;,}\]]+))/gim;

const PROVIDER_ASSIGNMENT_KINDS: Readonly<Record<string, SecretKind>> = {
  ANTHROPIC_API_KEY: 'ANTHROPIC',
  OPENAI_API_KEY: 'OPENAI',
  XAI_API_KEY: 'XAI',
  GOOGLE_API_KEY: 'GOOGLE',
  GOOGLE_GENERATIVE_AI_API_KEY: 'GOOGLE',
  GEMINI_API_KEY: 'GOOGLE',
  DEEPSEEK_API_KEY: 'DEEPSEEK',
  MOONSHOT_API_KEY: 'MOONSHOT',
  KIMI_API_KEY: 'MOONSHOT',
};

const STATIC_DETECTORS: readonly PatternDetector[] = [
  {
    kind: 'PEM_PRIVATE_KEY',
    pattern: /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?-----END \1-----/g,
    priority: 0,
    extractValue: (match) => match[0],
  },
  {
    kind: 'CREDENTIAL_URL',
    pattern: /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@]+@[^\s"'<>]+)/g,
    priority: 5,
    extractValue: (match) => match[1],
  },
  {
    kind: 'ANTHROPIC',
    pattern: /(?<![A-Za-z0-9_-])(sk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{16,})(?![A-Za-z0-9_-])/g,
    priority: 20,
    extractValue: (match) => match[1],
  },
  {
    kind: 'OPENAI',
    pattern:
      /(?<![A-Za-z0-9_-])(sk-(?!ant-)(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{20,})(?![A-Za-z0-9_-])/g,
    priority: 20,
    extractValue: (match) => match[1],
  },
  {
    kind: 'XAI',
    pattern: /(?<![A-Za-z0-9_-])(xai-[A-Za-z0-9_-]{20,})(?![A-Za-z0-9_-])/gi,
    priority: 20,
    extractValue: (match) => match[1],
  },
  {
    kind: 'GOOGLE',
    pattern: /(?<![A-Za-z0-9_-])(AIza[A-Za-z0-9_-]{35})(?![A-Za-z0-9_-])/g,
    priority: 20,
    extractValue: (match) => match[1],
  },
  {
    kind: 'SESSION_COOKIE',
    pattern:
      /(?:^|[;\s])(?:__Host-|__Secure-)?(?:session(?:id|_id|[-_.]?(?:token|cookie))?|connect\.sid|next-auth\.session-token|authjs\.session-token|better-auth\.session_token|jsessionid|phpsessid|asp\.net_sessionid)[ \t]*=[ \t]*(?:"([^"\r\n;]+)"|'([^'\r\n;]+)'|([^\s;,"']+))/gim,
    priority: 30,
    extractValue: (match) => match[1] ?? match[2] ?? match[3],
  },
  {
    kind: 'BEARER_TOKEN',
    pattern: /\bBearer[ \t]+([A-Za-z0-9._~+\/-]{16,}={0,2})(?![A-Za-z0-9._~+\/=-])/gi,
    priority: 40,
    extractValue: (match) => match[1],
  },
  {
    kind: 'PASSWORD',
    pattern:
      /(?:^|[\r\n,{])[ \t]*(?:-[ \t]+)?(?:export[ \t]+)?["']?[A-Za-z0-9_.-]*(?:password|passwd|pwd)[A-Za-z0-9_.-]*["']?[ \t]*(?:=|:)[ \t]*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#;,}\]]+))/gim,
    priority: 50,
    extractValue: (match) => match[1] ?? match[2] ?? match[3],
  },
];

function candidateFromMatch(
  kind: SecretKind,
  priority: number,
  match: RegExpExecArray,
  value: string | undefined,
): Candidate | undefined {
  if (value === undefined || value.length === 0) return undefined;

  const relativeStart = match[0].lastIndexOf(value);
  if (relativeStart < 0) return undefined;

  const start = match.index + relativeStart;
  return { kind, start, end: start + value.length, value, priority };
}

function providerAssignmentCandidates(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  PROVIDER_ASSIGNMENT_PATTERN.lastIndex = 0;

  let match = PROVIDER_ASSIGNMENT_PATTERN.exec(text);
  while (match !== null) {
    const providerName = match[1]?.toUpperCase();
    const kind = providerName === undefined ? undefined : PROVIDER_ASSIGNMENT_KINDS[providerName];
    const value = match[2] ?? match[3] ?? match[4];
    const candidate = kind === undefined ? undefined : candidateFromMatch(kind, 10, match, value);

    if (candidate !== undefined) candidates.push(candidate);
    match = PROVIDER_ASSIGNMENT_PATTERN.exec(text);
  }

  return candidates;
}

function staticCandidates(text: string): Candidate[] {
  const candidates: Candidate[] = [];

  for (const detector of STATIC_DETECTORS) {
    detector.pattern.lastIndex = 0;
    let match = detector.pattern.exec(text);

    while (match !== null) {
      const candidate = candidateFromMatch(
        detector.kind,
        detector.priority,
        match,
        detector.extractValue(match),
      );
      if (candidate !== undefined) candidates.push(candidate);
      match = detector.pattern.exec(text);
    }
  }

  return candidates;
}

function selectNonOverlapping(candidates: readonly Candidate[]): Candidate[] {
  const ordered = [...candidates].sort(
    (left, right) =>
      left.start - right.start ||
      left.priority - right.priority ||
      right.end - left.end ||
      left.kind.localeCompare(right.kind),
  );
  const selected: Candidate[] = [];
  let previousEnd = -1;

  for (const candidate of ordered) {
    if (candidate.start < previousEnd) continue;
    selected.push(candidate);
    previousEnd = candidate.end;
  }

  return selected;
}

export function scanAndRedact(text: string): RedactionResult {
  const selected = selectNonOverlapping([
    ...providerAssignmentCandidates(text),
    ...staticCandidates(text),
  ]);
  const findings: SecretFinding[] = selected.map(({ kind, start, end, value }) => ({
    kind,
    start,
    end,
    confidence: 'high',
    replacement: `<SECRET:${kind}:${createHash('sha256')
      .update(kind + value)
      .digest('hex')
      .slice(0, 8)}>`,
  }));
  let redacted = text;

  for (let index = findings.length - 1; index >= 0; index -= 1) {
    const finding = findings[index];
    if (finding === undefined) continue;
    redacted = `${redacted.slice(0, finding.start)}${finding.replacement}${redacted.slice(finding.end)}`;
  }

  return {
    redacted,
    findings,
    hardBlocked: findings.length > 0,
  };
}
