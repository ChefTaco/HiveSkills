/** Opt-in rollout automation settings (see src/rollout.ts). Free of storage imports, for config. */
export type RolloutPolicy = { promoteAfter: number | null; autoRollback: boolean };
export type Receipt = { status: string; skills: Record<string, { version: string; sha256: string }> };

export function parseRolloutPolicyEnv(env: NodeJS.ProcessEnv): RolloutPolicy {
  const raw = env.HIVE_SKILLS_CANARY_PROMOTE_AFTER?.trim();
  let promoteAfter: number | null = null;
  if (raw) {
    promoteAfter = Number(raw);
    if (!Number.isSafeInteger(promoteAfter) || promoteAfter < 1 || promoteAfter > 1000) throw new Error('HIVE_SKILLS_CANARY_PROMOTE_AFTER must be an integer from 1 to 1000');
  }
  const rollback = env.HIVE_SKILLS_CANARY_AUTO_ROLLBACK?.trim();
  if (rollback && rollback !== 'true' && rollback !== 'false') throw new Error('HIVE_SKILLS_CANARY_AUTO_ROLLBACK must be true or false');
  return { promoteAfter, autoRollback: rollback === 'true' };
}

