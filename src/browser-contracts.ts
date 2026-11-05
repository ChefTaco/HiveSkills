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
export const Target = z.object({
  name: z.string(),
  host: z.string(),
  username: z.string(),
  enabled: z.boolean(),
});
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
export const CreateSkill = z.object({
  slug: z.string().min(1).max(63),
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(5000),
  homepage: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});
export const UploadRelease = z.object({
  version: z.string(),
  archiveBase64: z.string(),
  notes: z.string().optional(),
  minHermesVersion: z.string().optional(),
  maxHermesVersion: z.string().optional(),
});
export const EnrollTarget = z.object({
  channel: z.enum(['stable', 'canary']),
  skills: z.array(z.string()).optional(),
});
export const browserSchemas = {
  ManagedDeployment, DeploymentApproval, DeploymentCapabilities,
  Skill,
  Release,
  Channel,
  Target,
  Audit,
  Receipt,
  DeploymentJob,
  CreateSkill,
  UploadRelease,
  EnrollTarget,
};
