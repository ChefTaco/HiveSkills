export type Skill = {
  slug: string;
  name: string;
  description: string;
  homepage: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Release = {
  skillSlug: string;
  version: string;
  sha256: string;
  archivePath: string;
  notes: string | null;
  minHermesVersion?: string | null;
  maxHermesVersion?: string | null;
  createdAt: string;
};

export type Session = { id: string; username: string; expiresAt: string };
export type DeploymentTarget = { name: string; host: string; username: string; enabled: boolean };
/** Optional fleet binding; agent references use `<magnusNodeId>~<profile>`. */
export type TargetBinding = { magnusNodeId: string; agentRefs: string[] };
export type ListedTarget = DeploymentTarget & { magnusNodeId?: string; agentRefs?: string[] };
export type AuthContext = { username: string; isAdmin: boolean };
