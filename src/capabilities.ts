/**
 * Suite service capabilities this HiveSkills build provides, reported as `capabilities` by
 * `GET /health/live`, `GET /health/ready` and `GET /healthz` so peers such as Magnus can
 * negotiate without guessing from versions.
 *
 * - `skills.pinned-release.v1`: `GET /v1/skills/:slug/releases/:version` and its archive serve
 *   one immutable release by exact version to a pinned-release reader, promoted or not.
 * - `skills.revocations.v1`: `GET /v1/revocations` serves the current signed revocation list and
 *   `PUT /admin/revocations` publishes a newer one.
 * - `skills.transparency-log.v1`: `GET /v1/transparency/head` and `GET /v1/transparency/entries` serve
 *   the signed, hash-chained transparency log of publications and revocations.
 */
export const SERVICE_CAPABILITIES = ['skills.pinned-release.v1', 'skills.revocations.v1', 'skills.transparency-log.v1'] as const;
