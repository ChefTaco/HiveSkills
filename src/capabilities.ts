/**
 * Suite service capabilities this HiveSkills build provides, reported as `capabilities` by
 * `GET /health/live`, `GET /health/ready` and `GET /healthz` so peers such as Magnus can
 * negotiate without guessing from versions.
 *
 * - `skills.pinned-release.v1`: `GET /v1/skills/:slug/releases/:version` and its archive serve
 *   one immutable release by exact version to a pinned-release reader, promoted or not.
 */
export const SERVICE_CAPABILITIES = ['skills.pinned-release.v1'] as const;
