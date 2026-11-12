# Changelog

## [Unreleased]

### Added

- `GET /v1/audit/export`, the suite audit export for Cindertrace: every stored audit record as a HiveAuditRecord v1 (`hiveskills:audit:<id>`), oldest first by id with opaque `after` cursors and `limit` 1 to 200 (default 100), and no retention window. `nextCursor` is the last record's cursor even on the final page and `null` only when a page is empty. Oathweave service tokens need the new `hiveskills:audit:read` permission; registry administrators are accepted as before. Records about deployment targets carry the target's Magnus node and agent in `subject`; details are redacted flat scalars of at most 4 KB, and session ids are never exported. No storage change. `GET /admin/audit` is unchanged. OpenAPI and browser contracts add `HiveAuditRecord`, `HiveAuditPage` and `HiveAuditQuery`.
- Optional `OATHWEAVE_NATIVE_ISSUERS` to accept service tokens signed with Oathweave's native issuer.

## [1.6.0] - 2026-11-12

### Added

- `GET /v1/hive/events`, a HiveEvent v1 feed for the HiveXUI inbox (cursor paging with `after` and `limit`, 14-day window, oldest first). It is derived from existing records with no migration: deployment outcomes (`deployment.succeeded`, `deployment.failed`, `deployment.expired`, `deployment.unknown`), failed agent restarts from target receipts (`target.restart.failed`) and audited release changes (`skill.release.published`, `skill.release.promoted`, `skill.release.withdrawn`, `skill.deleted`). Events link to the HiveXUI skills screen and carry the target's linked Magnus node and agent. Access matches `GET /admin/receipts`. Every event is validated with `@hivemagnus/hive-common` before it is served. OpenAPI and browser contracts add `HiveEvent`, `HiveEventPage` and `HiveEventQuery`.

### Changed

- Require `@hivemagnus/hive-common` 0.4.0 for the shared event feed helpers.

### Removed

- Retire the standalone web UI (`src/ui.ts`). HiveXUI is now the only UI for the Hive:Magnus product line, including HiveSkills. All API routes are unchanged.

### Changed

- `GET /` now serves a static page saying HiveSkills is managed in HiveXUI. Old bookmarks to the registry's web UI move to HiveXUI: set the new optional `HIVEXUI_URL` to have `/` redirect (`302`) there. An invalid `HIVEXUI_URL` (not an absolute http(s) URL, or one with credentials or a fragment) fails startup.

## [1.5.0] - 2026-11-12

- Link deployment targets to the fleet with optional `magnusNodeId` and up to 64 unique `agentRefs` (`<magnusNodeId>~<profile>`) on `PUT /admin/targets/:name`. Omitted fields keep the stored link, so existing clients cannot erase it. Linked targets list both fields; unlinked targets are listed exactly as before. The additive `managed-format-3` migration stores links in a side table, leaving existing target rows and older binaries unaffected.
- Add optional exact filters `GET /admin/targets?nodeId=` and `GET /admin/receipts?targetId=`. Responses without the parameters are unchanged; an invalid filter returns 400 in the existing error format. Browser contracts export `MagnusNodeId`, `AgentRef`, `TargetQuery` and `ReceiptQuery`.

## [1.4.0] - 2026-11-12

- Verify Oathweave access tokens with the shared `@hivemagnus/hive-common` verifier and run its conformance vectors in the test suite. Accepted principals, audience, permissions, account links and error responses are unchanged; the registry keeps zero clock tolerance, an online session check on every request and its required `roles` and `clientId` claims.
- Add `GET /health/ready` with the suite-standard readiness body. `GET /healthz` and `GET /health/live` keep their existing responses.
- Echo `x-request-id` on every response, accepting an inbound `x-request-id`, `x-hive-request-id` or `x-correlation-id` and continuing W3C `traceparent`.

## [1.3.4] - 2026-11-11

- Refuse native deployments and service restarts on Node.js below the package security minimum before changing remote state.
- Require patched Node.js 24.22.3 or 26.13.1, and refresh build and runtime image pins for upstream TLS and HTTP/2 security fixes.
- Upgrade Hono to 4.13.18 to bound request-body memory independently of transfer chunk count (GHSA-39q9-qp46-w8xg).

## [1.3.3] - 2026-11-10

### Security

- Run containers on a pinned, maintained Node 26 runtime with patched system libraries.
- Replace the embedded SQLite driver with `@photostructure/sqlite` 3.3.1 (SQLite 3.54.1); retain existing databases, transaction ownership and recovery checks. Supported Linux x64 and arm64 installs include Node-API binaries and require no compiler or dependency install scripts.

## 1.3.2 - 2026-11-09

- Catalog entries without a promoted release explicitly return `release: null`. Clients can
  explain that no release is available instead of failing response validation. Canary and
  stable assignments remain independent.

## 1.3.1 - 2026-11-05

### Security

- Remove npm, npx, corepack and yarn and the apt package tooling (apt,
  libapt-pkg6.0) from the runtime image; the service never invokes a package
  manager at runtime. This drops the bundled npm's brace-expansion 5.0.9
  (CVE-2026-102276, CVE-2026-102278) and undici 6.28.0 (CVE-2026-19534,
  CVE-2026-109383, CVE-2026-109869, CVE-2026-87018) and apt 2.6.1
  (CVE-2026-109518). dpkg and its package database remain so scanners can still
  inventory OS packages. The image has no HIGH or CRITICAL finding with an
  available fix (Trivy 0.70.0).
- HIGH and CRITICAL findings in Debian 12 base packages that have no fix yet:
  zlib1g CVE-2023-45853 (critical) and CVE-2026-76844; util-linux and its
  libraries CVE-2026-53613, CVE-2026-53615 and CVE-2026-78410; ncurses
  CVE-2025-69720; libsystemd0 and libudev1 CVE-2026-16742; gzip CVE-2026-41992;
  libacl1 CVE-2026-54369; perl-base CVE-2026-9538.

## 1.3.0 - 2026-11-05

- Export standalone product-owned browser validators, including exact request bounds, enrollment credentials and deployment responses. Validate administration writes against those same contracts and omit private archive paths from release creation replies.

- Export reviewed public native client archives with exact file/runtime digests and preserved license notices for publisher-signed installer staging.

- Revalidate native target authorization and the exact approved assignment before frozen deployments touch profile state. Disabled targets cannot approve or begin queued work.

- Add exact publication deployment previews, expiring one-use approvals, durable Magnus job references and receipt-only recovery. Suite deployments no longer execute the legacy SSH helper; interrupted jobs stay unknown until reviewed.

### Ecosystem extraction

Add browser-safe release history and bounded audit APIs with owned OpenAPI contracts.
Rehearsals and explicitly disabled deployment workers preserve queued and running jobs without recovering or dispatching them.

Independent product snapshot, container build and direct Oathweave authorization with explicit product-account links. Existing machine protocols remain available. Suite lifecycle and migration acceptance remain pending.

Browser skill deployment requests remain unavailable until the authenticated Magnus job adapter is configured. Native compatibility and registry reads remain available. Containers bind their service listener explicitly.
