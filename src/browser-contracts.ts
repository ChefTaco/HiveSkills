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
export const Release = z.object({
  skillSlug: z.string(),
  version: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  notes: z.string().nullable(),
  minHermesVersion: z.string().nullable().optional(),
  maxHermesVersion: z.string().nullable().optional(),
  createdAt: z.string(),
});
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
});
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
export const browserSchemas = {UpdateSkill,UpdateTarget,PromoteRelease,AuthMe,Ok,EnrollmentResponse,SkillList,ReleaseList,ChannelList,TargetList,AuditList,ReceiptList,DeploymentJobList,
  ManagedDeployment,DeploymentApproval,DeploymentCapabilities,Skill,Release,Channel,Target,Audit,Receipt,DeploymentJob,CreateSkill,UploadRelease,EnrollTarget,EmptyResponse,
  MagnusNodeId,AgentRef,TargetQuery,ReceiptQuery,HiveEvent,HiveEventPage,HiveEventQuery
};
