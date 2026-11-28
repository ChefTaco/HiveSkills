import { z } from 'zod';

export const Skill = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  homepage: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
// An advisory notice on an immutable release. The release stays immutable and downloadable;
// `yanked` additionally blocks new promotions. Pinned readers see it in the release metadata.
export const ReleaseAdvisory = z.object({ level: z.enum(['deprecated', 'yanked']), reason: z.string(), since: z.string() }).strict();
// A publisher's Ed25519 signature (base64url) of `hiveskills-release-signature-v1\n<slug>\n<version>\n<sha256>\n`.
export const ReleaseSignature = z.object({ keyId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), value: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export const Release = z.object({
  skillSlug: z.string(),
  version: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  notes: z.string().nullable(),
  minHermesVersion: z.string().nullable().optional(),
  maxHermesVersion: z.string().nullable().optional(),
  createdAt: z.string(),
  advisory: ReleaseAdvisory.nullable().optional(),
  signature: ReleaseSignature.nullable().optional(),
});
// One immutable release by exact version (GET /v1/skills/:slug/releases/:version), promoted or not.
// size is null when the stored archive is missing; channels lists where this version is promoted now.
export const PinnedRelease = z.object({
  slug: z.string(),
  version: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative().nullable(),
  notes: z.string().nullable(),
  compatibility: z.object({ minHermesVersion: z.string().nullable(), maxHermesVersion: z.string().nullable() }).strict(),
  channels: z.array(z.enum(['stable', 'canary'])),
  archiveUrl: z.string(),
  createdAt: z.string(),
  advisory: ReleaseAdvisory.nullable(),
  signature: ReleaseSignature.nullable(),
}).strict();
export const Channel = z.object({
  channel: z.enum(['stable', 'canary']),
  skill_slug: z.string(),
  version: z.string(),
});
// Fleet join keys: a Magnus node id and `<magnusNodeId>~<profile>` agent references.
const fleetRefPart = '[A-Za-z0-9._-]{1,128}';
export const MagnusNodeId = z.string().regex(new RegExp(`^${fleetRefPart}$`));
export const AgentRef = z.string().regex(new RegExp(`^${fleetRefPart}~${fleetRefPart}$`));
export const maxAgentRefs = 64;
export const Target = z.object({
  name: z.string(),
  host: z.string(),
  username: z.string(),
  enabled: z.boolean(),
  // Present only for targets bound to a Magnus node; legacy targets omit both.
  magnusNodeId: z.string().optional(),
  agentRefs: z.array(z.string()).optional(),
});
export const TargetQuery = z.object({ nodeId: MagnusNodeId.optional() });
export const Audit = z.object({
  id: z.number(),
  actor: z.string(),
  action: z.string(),
  subject: z.string(),
  details: z.string(),
  created_at: z.string(),
});
export const Receipt = z.object({
  target: z.string(),
  channel: z.enum(['stable', 'canary']),
  skills_json: z.string().nullable(),
  receipt_json: z.string().nullable(),
  updated_at: z.string(),
});
export const ReceiptQuery = z.object({ targetId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/).optional() });
export const DeploymentJob = z.object({
  id: z.string(),
  target: z.string(),
  actor: z.string(),
  status: z.enum(['awaiting_approval', 'queued', 'running', 'completed', 'failed', 'unknown']),
  result: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export const DeploymentCapabilities = z.object({enabled:z.boolean(),executor:z.literal('magnus'),message:z.string()});
export const ManagedDeployment = DeploymentJob.extend({manifest_json:z.string(),publication_sha256:z.string().regex(/^[a-f0-9]{64}$/),approval_expires_at:z.string(),approved_at:z.string().nullable(),magnus_job_id:z.string().nullable()});
export const DeploymentApproval = z.object({publicationSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const requiredText = (max:number) => z.string().max(max).trim().min(1);
const optionalText = (max:number) => z.string().max(max).trim().nullable().optional();
export const CreateSkill = z.object({
  slug: requiredText(63).toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: requiredText(120),
  description: requiredText(5000),
  homepage: optionalText(2000),
  enabled: z.boolean().optional(),
});
export const UploadRelease = z.object({
  version: requiredText(64).regex(/^v?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i),
  archiveBase64: requiredText(70 * 1024 * 1024),
  notes: optionalText(5000),
  minHermesVersion: optionalText(64),
  maxHermesVersion: optionalText(64),
  // Both or neither: a publisher signature checked against HIVE_SKILLS_PUBLISHER_KEYS at upload.
  signatureKeyId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/).optional(),
});
export const SetReleaseSignature = z.object({ keyId: ReleaseSignature.shape.keyId, value: ReleaseSignature.shape.value }).strict();
export const SetReleaseAdvisory = z.object({ level: z.enum(['deprecated', 'yanked']), reason: requiredText(1000) }).strict();
// A raw `application/gzip` release upload carries these fields in its query string.
export const UploadArchiveQuery = UploadRelease.omit({ archiveBase64: true }).strict();
export const EnrollTarget = z.object({
  channel: z.enum(['stable', 'canary']),
  skills: z.array(requiredText(63).toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/)).optional(),
});
// Complete browser operations retain product ownership of writes and one-time credentials.
export const UpdateSkill = z.object({ name:requiredText(120).optional(), description:requiredText(5000).optional(), homepage:optionalText(2000), enabled:z.boolean().optional() });
// Omitted fleet fields keep the stored binding; null or [] clears it. Agent references must belong to magnusNodeId.
export const UpdateTarget = z.object({host:requiredText(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/),username:requiredText(32).regex(/^[a-z_][a-z0-9_-]*$/i),enabled:z.boolean().optional(),magnusNodeId:MagnusNodeId.nullable().optional(),agentRefs:z.array(AgentRef).max(maxAgentRefs).optional()});
export const PromoteRelease = z.object({version:requiredText(64)});
export const AuthMe = z.object({username:z.string(),isAdmin:z.boolean()});
export const Ok = z.object({ok:z.literal(true)});
export const EmptyResponse = z.null();
export const EnrollmentResponse = z.object({target:z.string(),token:z.string(),oneTime:z.literal(true)});
export const SkillList = z.array(Skill), ReleaseList=z.array(Release), ChannelList=z.array(Channel), TargetList=z.array(Target), AuditList=z.array(Audit), ReceiptList=z.array(Receipt), DeploymentJobList=z.array(DeploymentJob);
// HiveEvent v1 feed (GET /v1/hive/events), mirroring @hivemagnus/hive-common's validator.
export const HiveEventQuery = z.object({
  after: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/).optional(),
  limit: z.coerce.number().int().min(1).optional(),
});
export const HiveEvent = z.object({
  id: z.string().max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  product: z.literal('hiveskills'),
  type: z.enum(['deployment.succeeded', 'deployment.failed', 'deployment.expired', 'deployment.unknown', 'target.restart.failed', 'skill.release.published', 'skill.release.promoted', 'skill.release.withdrawn', 'skill.deleted']),
  severity: z.enum(['info', 'warning', 'critical']),
  title: z.string().min(1).max(200),
  summary: z.string().max(2000),
  occurredAt: z.iso.datetime(),
  subject: z.object({ nodeId: z.string().regex(/^[a-z0-9_-]{2,32}$/).optional(), agentRef: z.string().regex(/^[a-z0-9_-]{2,32}~[a-z0-9_-]{2,32}$/).optional() }).strict().optional(),
  link: z.object({ product: z.literal('hiveskills'), path: z.string().regex(/^\/(?![/\\])/) }).strict(),
  sourceRef: z.string().min(1).max(256).optional(),
}).strict();
export const HiveEventPage = z.object({ data: z.array(HiveEvent), nextCursor: z.string().nullable() }).strict();
// HiveAuditRecord v1 (GET /v1/audit/export), the suite audit export record shared unchanged across products.
const auditScalar = z.union([z.string(), z.number(), z.boolean()]);
export const HiveAuditRecord = z.object({
  id: z.string().min(1).max(256).regex(/^(hivemem|hiveskills|ardentstudio|embermend):audit:[A-Za-z0-9._:-]{1,200}$/),
  product: z.enum(['hivemem', 'hiveskills', 'ardentstudio', 'embermend']),
  occurredAt: z.iso.datetime(),
  action: z.string().max(128).regex(/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/),
  outcome: z.enum(['success', 'failure']),
  actor: z.object({ type: z.enum(['user', 'service', 'agent', 'system']), id: z.string().min(1).max(256), issuer: z.string().max(512).optional(), displayName: z.string().max(256).optional() }).strict(),
  target: z.object({ type: z.string().min(1).max(64).optional(), id: z.string().min(1).max(512).optional() }).strict().optional(),
  subject: z.object({ actorId: z.string().min(1).max(256).optional(), agentRef: z.string().min(1).max(257).optional(), nodeId: z.string().min(1).max(128).optional() }).strict().optional(),
  details: z.record(z.string(), auditScalar).refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= 4096, 'details exceed 4 KB'),
}).strict();
export const HiveAuditPage = z.object({ data: z.array(HiveAuditRecord), nextCursor: z.string().nullable() }).strict();
export const HiveAuditQuery = z.object({
  after: z.string().regex(/^[A-Za-z0-9._~:-]{1,512}$/).optional(),
  limit: z.coerce.number().int().min(1).optional(),
});
// Signed revocation lists (GET /v1/revocations, PUT /admin/revocations). `payload` is the exact JSON
// string a pinned revocation key signed: `hiveskills-revocation-list-v1\n<payload>`.
const keyId = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const rawEd25519Key = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const PublishRevocations = z.object({ payload: z.string().min(2).max(384 * 1024), signature: ReleaseSignature }).strict();
export const SignedRevocationList = z.object({ sequence: z.number().int().positive(), payload: z.string(), payloadSha256: digest, signature: ReleaseSignature, publishedAt: z.string() }).strict();
export const RevocationsPublished = z.object({ sequence: z.number().int().positive(), keys: z.number().int().nonnegative(), releases: z.number().int().nonnegative(), withdrawn: z.array(z.object({ slug: z.string(), version: z.string(), channel: z.enum(['stable', 'canary']) }).strict()) }).strict();
export const RevokedKey = z.object({ keyId, publicKey: rawEd25519Key, reason: z.string(), revokedAt: z.string() }).strict();
export const RevokedRelease = z.object({ slug: z.string(), version: z.string(), sha256: digest, reason: z.string(), revokedAt: z.string() }).strict();
// What a Hermes bridge reports in a receipt about revoked releases and keys it acted on.
export const ReceiptRevocation = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/), version: z.string().max(64), reason: z.enum(['release', 'key']), keyId: keyId.optional(), action: z.enum(['refused', 'quarantined', 'reported']) }).strict();
// The transparency log (GET /v1/transparency/head and /v1/transparency/entries). `entry` is the exact
// string that was hashed (sha256 of `hiveskills-transparency-entry-v1\n<entry>`) and signed.
export const TransparencyHead = z.object({ size: z.number().int().nonnegative(), headHash: digest, signedAt: z.string(), logKey: z.object({ keyId: z.string().regex(/^log-[a-f0-9]{16}$/), publicKey: rawEd25519Key }).strict(), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export const TransparencyEntry = z.object({ index: z.number().int().nonnegative(), entry: z.string(), hash: digest, keyId: z.string(), signature: z.string() }).strict();
export const TransparencyEntries = z.object({ entries: z.array(TransparencyEntry), nextFrom: z.number().int().nonnegative().nullable() }).strict();
export const TransparencyEntriesQuery = z.object({ from: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(500).optional() });
// GET /admin/signatures: everything the HiveXUI signatures screen shows, in one read.
export const SignatureStatus = z.enum(['verified', 'unsigned', 'unknown_key', 'invalid', 'revoked_key', 'revoked']);
export const SignatureOverview = z.object({
  requireSignedReleases: z.boolean(),
  publisherKeys: z.array(z.object({ keyId, publicKey: rawEd25519Key, revocation: z.object({ reason: z.string(), revokedAt: z.string() }).strict().nullable() }).strict()),
  revocationKeys: z.array(z.object({ keyId, publicKey: rawEd25519Key }).strict()),
  revocations: z.object({ sequence: z.number().int().positive(), issuedAt: z.string(), expiresAt: z.string().nullable(), expired: z.boolean(), signatureKeyId: keyId, payloadSha256: digest, publishedAt: z.string(), keys: z.array(RevokedKey), releases: z.array(RevokedRelease) }).strict().nullable(),
  releases: z.array(z.object({ slug: z.string(), version: z.string(), sha256: digest, createdAt: z.string(), channels: z.array(z.enum(['stable', 'canary'])), signatureKeyId: keyId.nullable(), status: SignatureStatus }).strict()),
  releasesTruncated: z.boolean(),
  log: TransparencyHead,
}).strict();
export const browserSchemas = {UpdateSkill,UpdateTarget,PromoteRelease,AuthMe,Ok,EnrollmentResponse,SkillList,ReleaseList,ChannelList,TargetList,AuditList,ReceiptList,DeploymentJobList,
  ManagedDeployment,DeploymentApproval,DeploymentCapabilities,Skill,Release,PinnedRelease,Channel,Target,Audit,Receipt,DeploymentJob,CreateSkill,UploadRelease,UploadArchiveQuery,ReleaseAdvisory,SetReleaseAdvisory,ReleaseSignature,SetReleaseSignature,EnrollTarget,EmptyResponse,
  MagnusNodeId,AgentRef,TargetQuery,ReceiptQuery,HiveEvent,HiveEventPage,HiveEventQuery,HiveAuditRecord,HiveAuditPage,HiveAuditQuery,
  PublishRevocations,SignedRevocationList,RevocationsPublished,RevokedKey,RevokedRelease,ReceiptRevocation,TransparencyHead,TransparencyEntry,TransparencyEntries,TransparencyEntriesQuery,SignatureStatus,SignatureOverview
};
