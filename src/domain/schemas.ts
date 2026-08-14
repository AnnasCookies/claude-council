import { z } from 'zod';

const NonEmptyStringSchema = z.string().min(1);
const TimestampSchema = z.string().datetime({ offset: true });

export const DataClassificationSchema = z.enum([
  'public',
  'internal',
  'confidential',
  'restricted',
]);
export type DataClassification = z.infer<typeof DataClassificationSchema>;

export const CouncilScopeSchema = z.enum(['general', 'project']);
export type CouncilScope = z.infer<typeof CouncilScopeSchema>;

export const ProviderFamilySchema = z.enum([
  'anthropic',
  'openai',
  'xai',
  'google',
  'deepseek',
  'moonshot',
]);
export type ProviderFamily = z.infer<typeof ProviderFamilySchema>;

export const ProjectPolicySchema = z.strictObject({
  projectId: NonEmptyStringSchema,
  classification: DataClassificationSchema,
  allowedProviders: z.array(ProviderFamilySchema),
  providerCeilings: z.partialRecord(ProviderFamilySchema, DataClassificationSchema).optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ProjectPolicy = z.infer<typeof ProjectPolicySchema>;

export const ModelTransportSchema = z.enum(['http', 'cli', 'subscription-cli']);
export type ModelTransport = z.infer<typeof ModelTransportSchema>;

export const ModelRouteSchema = z.strictObject({
  primary: NonEmptyStringSchema,
  fallbacks: z.array(NonEmptyStringSchema),
  transport: ModelTransportSchema,
  alternateTransports: z.array(ModelTransportSchema).optional(),
});
export type ModelRoute = z.infer<typeof ModelRouteSchema>;

export const ModelRouteRegistrySourceSchema = z.enum(['built-in', 'override']);
export type ModelRouteRegistrySource = z.infer<typeof ModelRouteRegistrySourceSchema>;

const BuiltInRouteSourcesSchema = z.strictObject({
  anthropic: z.literal('built-in'),
  openai: z.literal('built-in'),
  xai: z.literal('built-in'),
  google: z.literal('built-in'),
  deepseek: z.literal('built-in'),
  moonshot: z.literal('built-in'),
});
const ResolvedRouteSourcesSchema = z.strictObject({
  anthropic: ModelRouteRegistrySourceSchema,
  openai: ModelRouteRegistrySourceSchema,
  xai: ModelRouteRegistrySourceSchema,
  google: ModelRouteRegistrySourceSchema,
  deepseek: ModelRouteRegistrySourceSchema,
  moonshot: ModelRouteRegistrySourceSchema,
});
const BuiltInRegistryProvenanceSchema = z.strictObject({
  kind: z.literal('built-in-only'),
  routes: BuiltInRouteSourcesSchema,
});
const OverrideRegistryProvenanceSchema = z.strictObject({
  kind: z.literal('override'),
  overridePath: NonEmptyStringSchema,
  overrideSha256: z.string().regex(/^[a-f0-9]{64}$/),
  routes: ResolvedRouteSourcesSchema,
});
export const ModelRegistryProvenanceSchema = z.discriminatedUnion('kind', [
  BuiltInRegistryProvenanceSchema,
  OverrideRegistryProvenanceSchema,
]);
export type ModelRegistryProvenance = z.infer<typeof ModelRegistryProvenanceSchema>;

export const RoleCategorySchema = z.enum(['domain', 'maintainer', 'risk', 'systems', 'contrarian']);
export type RoleCategory = z.infer<typeof RoleCategorySchema>;

export const MotionImpactSchema = z.enum(['low', 'medium', 'high']);
export type MotionImpact = z.infer<typeof MotionImpactSchema>;

export const RefinementTriggerSchema = z.strictObject({
  materialDisagreement: z.literal(true),
  question: z.string().trim().min(1),
});
export type RefinementTrigger = z.infer<typeof RefinementTriggerSchema>;

export const RoleApplicabilitySchema = z.strictObject({
  domains: z.array(NonEmptyStringSchema),
  impacts: z.array(MotionImpactSchema),
  contested: z.boolean(),
});
export type RoleApplicability = z.infer<typeof RoleApplicabilitySchema>;

export const RoleLensSchema = z.strictObject({
  category: RoleCategorySchema,
  name: NonEmptyStringSchema,
  prompt: NonEmptyStringSchema,
  applicability: RoleApplicabilitySchema,
});
export type RoleLens = z.infer<typeof RoleLensSchema>;

export const ReducedQuorumNoticeSchema = z.strictObject({
  standingDefaultMinimumDistinctFamilies: z.literal(4),
  weakerThanStandingDefault: z.literal(true),
  warning: NonEmptyStringSchema,
});
export type ReducedQuorumNotice = z.infer<typeof ReducedQuorumNoticeSchema>;

export const QuorumPolicySchema = z
  .strictObject({
    minimumDistinctFamilies: z.number().int().min(1).max(ProviderFamilySchema.options.length),
    requiresContrarian: z.boolean(),
    chairProvider: ProviderFamilySchema.optional(),
    reducedQuorum: ReducedQuorumNoticeSchema.optional(),
  })
  .superRefine((policy, context) => {
    const notice = policy.reducedQuorum;
    if (notice === undefined) return;

    if (
      !policy.requiresContrarian ||
      policy.minimumDistinctFamilies < 3 ||
      policy.minimumDistinctFamilies >= notice.standingDefaultMinimumDistinctFamilies
    ) {
      context.addIssue({
        code: 'custom',
        path: ['reducedQuorum'],
        message: 'Reduced quorum is valid only for a three-family significant council',
      });
    }
    if (
      !notice.warning.includes(String(policy.minimumDistinctFamilies)) ||
      !notice.warning.includes(String(notice.standingDefaultMinimumDistinctFamilies)) ||
      !/standing default/i.test(notice.warning) ||
      !/weaker/i.test(notice.warning)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['reducedQuorum', 'warning'],
        message: 'Reduced-quorum warning must state both family floors and that it is weaker',
      });
    }
  });
export type QuorumPolicy = z.infer<typeof QuorumPolicySchema>;

export const RunManifestSchema = z.strictObject({
  motionId: NonEmptyStringSchema,
  scope: CouncilScopeSchema,
  classification: DataClassificationSchema,
  routes: z.partialRecord(ProviderFamilySchema, ModelRouteSchema),
  registryProvenance: ModelRegistryProvenanceSchema,
  lenses: z.array(RoleLensSchema),
  rounds: z.number().int().min(1).max(3),
  refinementTrigger: RefinementTriggerSchema.optional(),
  quorumPolicy: QuorumPolicySchema,
  evidenceReferences: z.array(NonEmptyStringSchema),
});
export type RunManifest = z.infer<typeof RunManifestSchema>;

export const SeatRouteSchema = z.enum(['primary', 'same-provider-fallback']);
export type SeatRoute = z.infer<typeof SeatRouteSchema>;

export const SeatErrorSchema = z.strictObject({
  code: NonEmptyStringSchema,
  message: NonEmptyStringSchema,
  retryable: z.boolean(),
});
export type SeatError = z.infer<typeof SeatErrorSchema>;

const SuccessfulSeatResponseSchema = z.strictObject({
  status: z.literal('ok'),
  seatId: NonEmptyStringSchema,
  provider: ProviderFamilySchema,
  requestedModel: NonEmptyStringSchema,
  actualModel: NonEmptyStringSchema,
  modelIdentity: z.literal('verified'),
  route: SeatRouteSchema,
  role: NonEmptyStringSchema,
  latencyMs: z.number().nonnegative(),
  answer: NonEmptyStringSchema,
});

const FailedSeatResponseShape = {
  seatId: NonEmptyStringSchema,
  provider: ProviderFamilySchema,
  requestedModel: NonEmptyStringSchema.optional(),
  actualModel: NonEmptyStringSchema.optional(),
  modelIdentity: z.enum(['verified', 'unverified']).optional(),
  route: SeatRouteSchema.optional(),
  role: NonEmptyStringSchema,
  latencyMs: z.number().nonnegative().optional(),
  error: SeatErrorSchema,
};

const FailedSeatResponseSchema = z.strictObject({
  status: z.literal('failed'),
  ...FailedSeatResponseShape,
});

const SkippedSeatResponseSchema = z.strictObject({
  status: z.literal('skipped'),
  ...FailedSeatResponseShape,
});

const TimedOutSeatResponseSchema = z.strictObject({
  status: z.literal('timed-out'),
  ...FailedSeatResponseShape,
});

const CancelledSeatResponseSchema = z.strictObject({
  status: z.literal('cancelled'),
  ...FailedSeatResponseShape,
});

export const SeatResponseSchema = z.discriminatedUnion('status', [
  SuccessfulSeatResponseSchema,
  FailedSeatResponseSchema,
  SkippedSeatResponseSchema,
  TimedOutSeatResponseSchema,
  CancelledSeatResponseSchema,
]);
export type SeatResponse = z.infer<typeof SeatResponseSchema>;
