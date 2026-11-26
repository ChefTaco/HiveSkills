// Opt-in rollout automation, evaluated when an agent receipt arrives. Both rules act only on the
// canary channel's current release and are audited as `system` promotions and withdrawals, which the
// HiveEvent feed reports as `skill.release.promoted` and `skill.release.withdrawn`.
//
// - HIVE_SKILLS_CANARY_PROMOTE_AFTER=N: once N distinct canary targets report `activated` with the
//   exact canary release (version and digest), promote it to stable.
// - HIVE_SKILLS_CANARY_AUTO_ROLLBACK=true: when a canary target reports `restart_failed` with the
//   exact canary release installed, put canary back on the stable release (or withdraw canary when
//   stable has none). A failure with the stable release installed changes nothing.
import { store } from './db.js';
import type { Receipt, RolloutPolicy } from './rollout-policy.js';

const parse = (json: unknown): Receipt | null => {
  try {
    const value = typeof json === 'string' ? JSON.parse(json) as unknown : json;
    if (!value || typeof value !== 'object') return null;
    const { status, skills } = value as Record<string, unknown>;
    return typeof status === 'string' && skills && typeof skills === 'object' ? { status, skills: skills as Receipt['skills'] } : null;
  } catch { return null; }
};

/** The canary release of `slug` when the receipt reports exactly it installed. */
const reportedCanary = (slug: string, receipt: Receipt) => {
  const canary = store.channelRelease('canary', slug);
  const installed = receipt.skills[slug];
  return canary && installed && installed.version === canary.version && installed.sha256 === canary.sha256 ? canary : undefined;
};

/** Apply the policy to one receipt from `target`, already stored. Returns what it changed. */
export function applyRolloutPolicy(policy: RolloutPolicy, target: string, receipt: Receipt): string[] {
  if (store.targetPolicy(target)?.channel !== 'canary') return [];
  const changes: string[] = [];
  for (const slug of Object.keys(receipt.skills)) {
    if (!store.getSkill(slug)?.enabled) continue;
    const canary = reportedCanary(slug, receipt);
    if (!canary) continue;
    const stable = store.channelRelease('stable', slug);
    if (receipt.status === 'restart_failed' && policy.autoRollback) {
      if (stable?.version === canary.version) continue;
      if (stable) {
        store.promoteRelease(slug, stable.version, 'canary');
        store.audit('system', 'release.promote', slug, { channel: 'canary', version: stable.version, automatic: 'rollback', failedVersion: canary.version, target });
        changes.push(`rollback ${slug} canary ${canary.version} -> ${stable.version}`);
      } else {
        store.withdrawRelease(slug, 'canary');
        store.audit('system', 'release.withdraw', slug, { channel: 'canary', automatic: 'rollback', failedVersion: canary.version, target });
        changes.push(`withdraw ${slug} canary ${canary.version}`);
      }
    } else if (receipt.status === 'activated' && policy.promoteAfter !== null && stable?.version !== canary.version) {
      if (store.releaseAdvisory(slug, canary.version)) continue;
      const healthy = (store.listReceipts() as Array<{ target: string; channel: string; receipt_json: string | null }>)
        .filter((row) => row.channel === 'canary' && store.getTarget(row.target))
        .filter((row) => { const reported = parse(row.receipt_json); return reported?.status === 'activated' && reportedCanary(slug, reported) !== undefined; })
        .length;
      if (healthy < policy.promoteAfter) continue;
      store.promoteRelease(slug, canary.version, 'stable');
      store.audit('system', 'release.promote', slug, { channel: 'stable', version: canary.version, automatic: 'canary_healthy', healthyTargets: healthy });
      changes.push(`promote ${slug} ${canary.version} to stable`);
    }
  }
  return changes;
}
