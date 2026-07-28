import { z } from 'zod';

const UNSAFE_XML_OR_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029<>"']/;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function isRepositoryRelativeLocator(value: string): boolean {
  if (
    value.trim() !== value ||
    value.length === 0 ||
    UNSAFE_XML_OR_CONTROL_CHARACTERS.test(value) ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    WINDOWS_ABSOLUTE_PATH.test(value) ||
    URI_SCHEME.test(value) ||
    value.includes('\\')
  ) {
    return false;
  }

  const fragmentIndex = value.indexOf('#');
  const fragment = fragmentIndex === -1 ? undefined : value.slice(fragmentIndex + 1);
  if (
    fragment !== undefined &&
    (fragment.length === 0 ||
      value.indexOf('#', fragmentIndex + 1) !== -1 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(fragment))
  ) {
    return false;
  }
  const path = fragmentIndex === -1 ? value : value.slice(0, fragmentIndex);
  if (path.length === 0 || path.includes('?')) return false;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    return false;
  }

  if (
    decodedPath !== path ||
    decodedPath === '~' ||
    decodedPath.startsWith('~/') ||
    decodedPath.startsWith('/') ||
    decodedPath.startsWith('\\') ||
    WINDOWS_ABSOLUTE_PATH.test(decodedPath) ||
    decodedPath.includes('\\')
  ) {
    return false;
  }

  const segments = decodedPath.split('/');
  return segments.every(
    (segment) =>
      segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':'),
  );
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  const [first = -1, second = -1] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function isPublicHttpsLocator(value: string): boolean {
  if (
    value.trim() !== value ||
    value.length === 0 ||
    UNSAFE_XML_OR_CONTROL_CHARACTERS.test(value) ||
    /\s/.test(value)
  ) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0) {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  if (
    hostname.length === 0 ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.includes(':') ||
    isPrivateIpv4(hostname)
  ) {
    return false;
  }

  return hostname.includes('.') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

export const EvidenceSourceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^(?![\s\S]*[\r\n\u2028\u2029])[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/,
    'Evidence source identifiers must contain only safe ASCII identifier characters',
  );

export const EvidenceKindSchema = z.enum(['local-instruction', 'repository', 'web']);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const EvidenceTrustSchema = z.enum(['trusted-local-instruction', 'untrusted']);
export type EvidenceTrust = z.infer<typeof EvidenceTrustSchema>;

export const RepositoryRelativeLocatorSchema = z
  .string()
  .max(2_048)
  .refine(isRepositoryRelativeLocator, 'Repository provenance must be a safe relative locator');

export const PublicEvidenceLocatorSchema = z
  .string()
  .max(2_048)
  .refine(isPublicHttpsLocator, 'Web provenance must be a public HTTPS locator');

const EvidenceContentSchema = z
  .string()
  .min(1)
  .refine((content) => content.trim().length > 0, 'Evidence content must not be blank')
  .refine(
    (content) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content),
    'Evidence content contains unsafe control characters',
  );

const RetrievedAtSchema = z.string().datetime({ offset: true });

const CommonInputShape = {
  id: EvidenceSourceIdSchema,
  content: EvidenceContentSchema,
  retrievedAt: RetrievedAtSchema,
};

export const TrustedLocalInstructionSchema = z.strictObject({
  ...CommonInputShape,
  kind: z.literal('local-instruction'),
  trust: z.literal('trusted-local-instruction'),
  locator: RepositoryRelativeLocatorSchema,
});

export const UntrustedLocalInstructionSchema = z.strictObject({
  ...CommonInputShape,
  kind: z.literal('local-instruction'),
  trust: z.literal('untrusted'),
  locator: RepositoryRelativeLocatorSchema,
});

export const UntrustedRepositoryEvidenceSchema = z.strictObject({
  ...CommonInputShape,
  kind: z.literal('repository'),
  trust: z.literal('untrusted'),
  locator: RepositoryRelativeLocatorSchema,
});

export const UntrustedWebEvidenceSchema = z.strictObject({
  ...CommonInputShape,
  kind: z.literal('web'),
  trust: z.literal('untrusted'),
  locator: PublicEvidenceLocatorSchema,
});

export const EvidenceInputSchema = z.union([
  TrustedLocalInstructionSchema,
  UntrustedLocalInstructionSchema,
  UntrustedRepositoryEvidenceSchema,
  UntrustedWebEvidenceSchema,
]);
export type EvidenceInput = z.infer<typeof EvidenceInputSchema>;

export const EvidenceInputsSchema = z.array(EvidenceInputSchema).superRefine((sources, context) => {
  const seen = new Set<string>();
  for (const [index, source] of sources.entries()) {
    if (seen.has(source.id)) {
      context.addIssue({
        code: 'custom',
        path: [index, 'id'],
        message: 'Evidence source identifiers must be unique',
      });
    }
    seen.add(source.id);
  }
});

export const EvidenceRedactionSummarySchema = z.strictObject({
  count: z.number().int().nonnegative(),
  hardBlocked: z.literal(false),
});
export type EvidenceRedactionSummary = z.infer<typeof EvidenceRedactionSummarySchema>;

const NormalisedFieldsShape = {
  excerpt: EvidenceContentSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  redaction: EvidenceRedactionSummarySchema,
};

const NormalisedTrustedLocalInstructionSchema = z.strictObject({
  ...CommonInputShape,
  kind: z.literal('local-instruction'),
  trust: z.literal('trusted-local-instruction'),
  locator: RepositoryRelativeLocatorSchema,
  ...NormalisedFieldsShape,
});

const NormalisedUntrustedLocalInstructionSchema = z.strictObject({
  ...CommonInputShape,
  kind: z.literal('local-instruction'),
  trust: z.literal('untrusted'),
  locator: RepositoryRelativeLocatorSchema,
  ...NormalisedFieldsShape,
});

const NormalisedRepositoryEvidenceSchema = z.strictObject({
  ...CommonInputShape,
  kind: z.literal('repository'),
  trust: z.literal('untrusted'),
  locator: RepositoryRelativeLocatorSchema,
  ...NormalisedFieldsShape,
});

const NormalisedWebEvidenceSchema = z.strictObject({
  ...CommonInputShape,
  kind: z.literal('web'),
  trust: z.literal('untrusted'),
  locator: PublicEvidenceLocatorSchema,
  ...NormalisedFieldsShape,
});

export const EvidenceSourceSchema = z.union([
  NormalisedTrustedLocalInstructionSchema,
  NormalisedUntrustedLocalInstructionSchema,
  NormalisedRepositoryEvidenceSchema,
  NormalisedWebEvidenceSchema,
]);
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const EvidencePackSchema = z
  .strictObject({
    sources: z.array(EvidenceSourceSchema),
    rendered: z.string().min(1),
  })
  .superRefine((pack, context) => {
    const seen = new Set<string>();
    for (const [index, source] of pack.sources.entries()) {
      if (seen.has(source.id)) {
        context.addIssue({
          code: 'custom',
          path: ['sources', index, 'id'],
          message: 'Evidence source identifiers must be unique',
        });
      }
      seen.add(source.id);
    }
  });
export type EvidencePack = z.infer<typeof EvidencePackSchema>;
