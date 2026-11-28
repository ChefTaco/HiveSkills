# Changelog

## [Unreleased]

### Added

- Signed revocation lists. A revocation authority key, pinned separately from the publisher keys with the new `HIVE_SKILLS_REVOCATION_KEYS`, signs a list of revoked publisher keys and releases (`node scripts/sign-release.mjs sign-revocations`). `PUT /admin/revocations` accepts a list only when such a key signed it, it has not expired and its `sequence` is above the current one; `GET /v1/revocations` serves it unchanged to enrolled targets and administrators. Releases are revoked by slug and version and by digest, keys by public key. Publishing withdraws every revoked release, and every release signed by a revoked pinned key, from its channels (audited as automatic `release.withdraw`, in the event feed); the registry then refuses to promote, upload or re-upload a revoked release (checked again in the storing transaction), to promote a release signed by a revoked key, and new signatures by a revoked key. Lists are append-only; `GET /v1/revocations/<sequence>` serves any earlier one.
- The Hermes bridge checks revocations. With `HIVE_SKILLS_REVOCATION_KEYS` in its environment it reads and verifies the list on every run, before activation, and fails closed on a missing, unverifiable, older (the highest sequence seen is kept in its state file), swapped or expired list. `HIVE_SKILLS_MIN_REVOCATION_SEQUENCE` pins a floor that holds even if the state file is lost. A revoked release, or one whose only valid signature is by a revoked publisher key, is refused before download; installed ones are quarantined, or with `HIVE_SKILLS_REVOKED_INSTALLED=report` only reported. The bridge checks the version and digest each installed skill actually runs as well as what the manifest offers, so revoked bytes relabelled as another version stay revoked, and an installed release whose verified key was revoked stays revoked when the registry withholds its signature. The bridge reports it to the registry in a receipt with the new status `revoked` and a `revocations` list, which `POST /v1/agent/receipts/:target` now accepts.
- An append-only transparency log of release publications, signatures, revocation lists (digest and signature; payloads served by sequence) and skill deletions: hash-chained, each entry and the head (with its signing time and key id) signed by the registry's log key (created on first use as `transparency-log-key.pem` in the data directory, or `HIVE_SKILLS_TRANSPARENCY_KEY_FILE`; a key file readable by group or others is refused), written in the same transaction as the change and refused any update or delete by the database. A version the log ever recorded cannot be uploaded again, even after its skill was deleted. On every start the registry records whatever was stored without an entry, marked `backfilled`, and withdraws revoked releases again. `GET /v1/transparency/head` and `GET /v1/transparency/entries` (pages bounded by count and size) serve it read-only to enrolled targets and administrators, and `scripts/verify-transparency-log.mjs` verifies it end to end (links, signatures, digests, deletions, sequences, revocation payloads, publisher signatures and revocation lists, and growth since a known head; `--page-size`), online or from a saved copy.
- `GET /admin/signatures`: pinned publisher and revocation keys, every release's signature status (`verified`, `unsigned`, `unknown_key`, `invalid`, `revoked_key`, `revoked`), the current revocation list and the log head, for the HiveXUI signatures screen. Browser contracts and the OpenAPI snapshot describe all new routes, and health bodies list the capabilities `skills.revocations.v1` and `skills.transparency-log.v1`.

### Changed

- CI fails when a document names a version that is no longer current (`npm run check:doc-versions`, tests in `npm test`): HiveSkills image tags, links into a Hive suite release, and "Hive X.Y.Z pins …" claims, which name no version because the signed suite release manifest is their only source. `CHANGELOG.md` and the retired 1.x launcher's documents (`hive/blob/v1.2.2`) are exempt.
- `HIVE_SKILLS_MAGNUS_EXECUTOR_JSON` may now set both `oathweave` and `credentialFile`. HiveSkills then prefers the Oathweave service token and falls back to the static credential file, once per request, only when no token can be obtained or Magnus still refuses the token with `401` or `403` (before it admits a job, so nothing is dispatched twice); any other answer or a lost request is never retried. Each fallback logs a warning. Configurations with only one of the two behave as before. This lets a registry move to Oathweave before Magnus accepts its token (Magnus with `HIVESKILLS_SERVICE` links, permission `magnus:hiveskills`, audience `magnus`); see the README's "Approved deployments through Magnus".

### Deprecated

- The static Magnus executor bearer (`credentialFile`). Configure `oathweave`, keep `credentialFile` as the fallback while Magnus is upgraded and linked, then remove it.

### Migrations

- `managed-format-6` (fast, additive): new tables `revocation_lists` and `transparency_log` with triggers that refuse updates and deletes. Release rows are untouched, but the data is readable only by HiveSkills 1.12.0 and later (`readableBy ^1.12.0`): an older binary would store and promote releases without the log or revocation checks. A suite upgrade needs `--allow-migrations` for HiveSkills, and **downgrading needs the backup the upgrade took**. Releasing this under a version other than 1.12.x requires updating `SKILLS_DATA_COMPATIBILITY`.

### Upgrade notes

- Registry: nothing is required. On first start the registry creates its transparency log key in the data directory and records existing releases in the log. Backups of the data directory now hold that private key: protect them, and rotate the key (README, "Transparency log") if one leaks. Re-uploading a version that existed before (for example after deleting a skill) is now refused; use a new version. To use revocations, generate a revocation authority key offline, set `HIVE_SKILLS_REVOCATION_KEYS` and publish an initial list (it may be empty).
- Agent hosts: redeploy the bridge (`scripts/hermes-sync.mjs` and `scripts/archive-utils.mjs`, or a new native client) to get revocation checks. Set `HIVE_SKILLS_REVOCATION_KEYS` in `bridge.env` only after the registry serves a list: a bridge that pins revocation keys refuses to sync while there is none. Optionally set `HIVE_SKILLS_MIN_REVOCATION_SEQUENCE`. Hosts that pin no revocation key behave as before.

## [1.11.1] - 2026-11-26

Repository tooling only: the image's runtime code is unchanged from 1.11.0.

### Changed

- Dependabot now opens one grouped weekly pull request (group `hivemagnus`) for `@hivemagnus/*` package updates, so suite package bumps arrive together. Repository configuration only; nothing to do when upgrading.

### Security

- The repository privacy checks (`scripts/check-private-data.sh` and `scripts/scan-secrets.sh`) now report a finding as `path:line: rule` and never print the matching text or the line around it, so a failing check cannot copy a private term or a credential into a public CI log. A path that itself contains a private term is shown as `(path redacted)`. Exit codes are unchanged, and `scripts/privacy-output.test.sh` (run in CI) plants fake values and checks they stay out of the output. Repository tooling only; nothing to do when upgrading.

### Migrations

- None. The database schema is unchanged from 1.11.0 (`managed-format-5`), so a suite upgrade needs no `--allow-migrations` for HiveSkills and downgrading to 1.11.0 is safe.

### Upgrade notes

- Nothing to do: no new settings, and the Hermes bridge is unchanged from 1.11.0, so agent hosts need no redeploy.

## [1.11.0] - 2026-11-26

### Added

- `HIVE_SKILLS_UNSIGNED_INSTALLED` for the Hermes bridge. With `HIVE_SKILLS_PUBLISHER_KEYS` pinned, the bridge now also checks the releases of skills installed before the keys were pinned (once per release and key, remembered in its state file). An unsigned one is reported on stderr and stays active (`report`, the default), or with `quarantine` is moved out of the gateway's skills directory to `~/.hermes/.hive-skills-sync/<slug>.quarantined`, the gateway is restarted and the sync fails; from then on it is refused like any unsigned release until it is signed. **Upgrade:** redeploy the bridge; hosts that pin keys make one metadata request per installed skill on the first sync after the upgrade and log any unsigned installed skill on every sync until it is signed or quarantined.

### Changed

- `HIVE_SKILLS_TRUSTED_PROXIES` also accepts CIDR ranges (`10.0.0.0/8`) and the presets `loopback`, `private` and `linklocal`, comma- or space-separated. Existing lists of exact addresses work unchanged.
- Require `@hivemagnus/hive-common` 0.7.0 (was 0.6.1), for `/rate-limit`.

### Fixed

- Automatic canary rollback (`HIVE_SKILLS_CANARY_AUTO_ROLLBACK=true`) now works with the shipped Hermes bridge and is scoped to what changed. The bridge used to throw on a failed gateway restart without telling the registry, so rollback never fired; it now posts a `restart_failed` receipt before exiting with the error. It also checks a running gateway is still active (and was not restarted again by systemd) after a settle delay before it reports `activated` (`HIVE_SKILLS_RESTART_SETTLE_MS`, default 10000), so promotion counts healthy gateways rather than accepted restart jobs. Receipts gain an optional `changed` list (the skills installed since the gateway last restarted cleanly, kept across runs while a restart is pending) and rollback acts only on the canary skills named there; previously every canary skill in the receipt was rolled back, including long-healthy ones. **Upgrade:** redeploy the bridge to agent hosts (`scripts/deploy-hermes-agent.sh`) to get the receipts; a sync that restarts a running gateway now takes about 10 seconds longer. A custom agent that sends `restart_failed` without `changed` no longer triggers a rollback.
- A release upload with a signature stores the release and its signature in one transaction, so a failure between the two can no longer leave an unsigned release behind.

### Security

- The sign-in throttle resolves the client address with HiveCommon `/rate-limit` (`resolveClientAddress()`, `addressKey()`) instead of its own `X-Forwarded-For` parser. Forwarded addresses with a port (`192.0.2.1:5678`, `[2001:db8::1]:443`) are now read as that client; previously they were invalid, so every client behind such a proxy shared the proxy's source budget. An IPv6 client is counted by its /64, so one host cannot get a fresh budget per address. The per-account delay table no longer refuses new accounts when full (previously a few sources, each within its own limit, could fill its 1000 slots and block every sign-in with `429`); it holds 10 000 and forgets the oldest delay. The `capacity` throttle reason is gone from `login.failed` audit rows.
- A session id is re-keyed from the pre-hashing format only when it has the issued format (43 base64url characters), so a stored 64-hex session hash can never be presented as a session id.

### Migrations

- None. The database schema is unchanged from 1.10.0 (`managed-format-5`), so a suite upgrade needs no `--allow-migrations` for HiveSkills and downgrading to 1.10.0 is safe.

### Upgrade notes

- Redeploy the Hermes bridge to agent hosts (`scripts/deploy-hermes-agent.sh`). Until then hosts keep the 1.10.0 bridge: no `restart_failed` receipts (so `HIVE_SKILLS_CANARY_AUTO_ROLLBACK` never fires for them), no settle check and no check of skills installed before publisher keys were pinned.
- A sync that restarts a running gateway takes about 10 seconds longer (the settle check, `HIVE_SKILLS_RESTART_SETTLE_MS`, default 10000).
- Hosts that pin `HIVE_SKILLS_PUBLISHER_KEYS` make one metadata request per installed skill on the first sync after the upgrade and log every unsigned installed skill on each sync until it is signed or quarantined (`HIVE_SKILLS_UNSIGNED_INSTALLED=quarantine`). With `quarantine` an unsigned installed skill is removed from the gateway and the sync fails.
- A custom agent that sends `restart_failed` without `changed` no longer triggers an automatic rollback.
- Behind a proxy that forwards addresses with a port, or for IPv6 clients, the sign-in throttle now counts per real client (IPv6 per /64) instead of sharing one budget; `HIVE_SKILLS_TRUSTED_PROXIES` may now use CIDR ranges and the `loopback`, `private` and `linklocal` presets. Audit consumers that matched the `capacity` throttle reason in `login.failed` rows no longer see it.

## [1.10.0] - 2026-11-26

### Added

- `POST /admin/skills/:slug/releases` also accepts the raw archive as `Content-Type: application/gzip` (or `application/x-gzip`), with `version`, `notes`, `minHermesVersion` and `maxHermesVersion` in the query string, so a 50 MiB archive is no longer sent as a 70 MB base64 JSON string. The JSON form is unchanged. Browser contracts add `UploadArchiveQuery`.
- Failed sign-ins are audited. A PAM failure, and the first refusal of each throttle delay or window, writes a `login.failed` audit row (the attempted account, client address and throttle state; never the password), exported to Cindertrace as `session.login_failed` with `outcome: "failure"`. Names no OS account can have are still answered `401` without an audit row.
- A per-source sign-in throttle: one client address may fail at most 10 times in 5 minutes across every account, then gets `429`. The per-account 15-second delay is unchanged. `429` answers now carry `Retry-After`. Optional `HIVE_SKILLS_TRUSTED_PROXIES` lists reverse-proxy IPs whose `X-Forwarded-For` names the client.
- The legacy SSH deployment worker audits each job's outcome (`deployment.finished`, exported as `deployment.complete` with a success or failure outcome), so the export no longer shows a `deployment.queue` with no result.
- Opt-in canary automation, evaluated on each agent receipt. `HIVE_SKILLS_CANARY_PROMOTE_AFTER=N` promotes the canary release to stable once `N` distinct canary targets report exactly that release (version and digest) `activated`; an advised release is never promoted automatically. `HIVE_SKILLS_CANARY_AUTO_ROLLBACK=true` acts on `restart_failed`: when the failing canary target has the canary release installed, canary is put back on the stable release, or withdrawn when stable has none. Changes are audited as `system` `release.promote`/`release.withdraw` (with `automatic`), so the HiveEvent feed reports them as `skill.release.promoted`/`skill.release.withdrawn` with automatic titles and summaries. Both are off by default.
- Publisher-signed releases. Releases can carry an Ed25519 publisher signature over `hiveskills-release-signature-v1\n<slug>\n<version>\n<sha256>\n`, given at upload (`signatureKeyId` and `signature`, JSON or raw-upload query) or attached later with `PUT /admin/skills/:slug/releases/:version/signature` (audited as `release.sign`). The registry verifies it against `HIVE_SKILLS_PUBLISHER_KEYS` and, with `HIVE_SKILLS_REQUIRE_SIGNED_RELEASES=true`, refuses unsigned uploads. Pinned-release metadata and the admin release list report `signature`. The Hermes bridge, given the same `HIVE_SKILLS_PUBLISHER_KEYS`, verifies every release it is about to install against the pinned keys (read from the pinned-release metadata with its target token) and refuses the sync before downloading or activating anything otherwise, so a compromised registry or admin session cannot push unsigned code to hosts that pin keys. `scripts/sign-release.mjs` generates keys and signs releases. The agent manifest is unchanged. Browser contracts add `ReleaseSignature` and `SetReleaseSignature`; `UploadRelease` gains the optional signature fields.
- Deprecation and yank notices on releases. `PUT /admin/skills/:slug/releases/:version/advisory` with `{"level":"deprecated"|"yanked","reason"}` sets (or replaces) a notice and `DELETE` on the same path clears it; both are audited (`release.advisory`, `release.advisory.clear`; exported as `release.advisory_set` and `release.advisory_clear`). Releases stay immutable and downloadable and keep their channels. Pinned readers learn of it: `GET /v1/skills/:slug/releases/:version` reports `advisory` (`{level, reason, since}` or `null`), archive downloads of an advised release carry `X-Release-Advisory: deprecated|yanked`, and `GET /admin/skills/:slug/releases` lists each release's `advisory`. A yanked release cannot be promoted (`409`). The agent manifest is unchanged, so approved Magnus publications compare equal as before. Browser contracts add `ReleaseAdvisory` and `SetReleaseAdvisory`.
- `HIVE_SKILLS_MAGNUS_EXECUTOR_JSON` accepts `oathweave: { tokenUrl, clientId, clientSecretFile, audience, scope? }` in place of `credentialFile`. HiveSkills then authenticates to the Magnus executor with short-lived, audience-bound Oathweave `client_credentials` tokens (HiveCommon `createServiceTokenProvider()`, cached and refreshed before expiry) instead of a long-lived bearer read from disk on every call, and after a `401` fetches a fresh token and retries once. Exactly one of the two must be configured; `credentialFile` works as before. The executor must accept Oathweave service tokens for the configured audience.

### Security

- Session ids are stored as their SHA-256, as the README already said; previously the raw id was stored, protected only by the cookie signature. A session created by an earlier release is re-keyed on its first use, so nobody is signed out.

### Changed

- Request body limits are per route. Only a release upload may be large (70 MiB as JSON, 50 MiB as a raw archive); an agent receipt may be 256 KiB and every other body, the unauthenticated `POST /auth/login` included, 64 KiB. Previously every route accepted 70 MiB, so an anonymous caller could make the server buffer and parse a 70 MB JSON body. Over-limit bodies are answered with `413` and `{"error":"Request body is too large"}` (previously a plain-text `413`).
- Archive downloads are streamed from the file instead of read into memory, with `Content-Length`. The digest check still runs before any byte is sent, but it is hashed in chunks without blocking other requests and cached by file size, mtime and inode, so an unchanged archive is hashed once rather than on every download.
- `GET /health/ready` and `GET /healthz` share one readiness run (which checks every promoted archive) for 5 seconds instead of repeating it on every probe. A database failure is never cached.

- The frozen Hive 1.2.2 bundle manifest (`hiveRelease` in `package.json`, which still named the retired `hive-router` and `hive-iam-server`) is gone. `migrate` builds HiveSkills' own release record in code with the same skills migration list, so the schema checksum and every installation's recorded state stay current. `GET /health/live` and `GET /healthz` now report `release` as the package version instead of `1.2.2`, and `GET /admin/updates` (with `HIVE_UPDATE_CHECK=true`) reasons about the installed package version.
- Require `@hivemagnus/hive-common` 0.6.1 (was 0.5.0). Its ReDoS fixes are not reachable here (`health.ready()` is called directly); this keeps the suite on one tested version.
- CI runs the gates on Node 24.22.3 and 26.13.1 (the image's runtime), builds the image and opens a database with the image's Node, and every third-party Action in CI and the release workflow is pinned by commit SHA.
- The two Node-version-dependent script tests no longer fail with assertion noise on an unsupported local Node: one passes the tested Node version explicitly, the other is skipped with a message naming the local version and the required range.

- Every error answer uses the suite envelope from `@hivemagnus/hive-common`: `{"error":{"code","message","requestId"}}` with `Cache-Control: no-store`, instead of `{"error":"text"}` (and `{"error":"DEPLOYMENT_ADAPTER_UNAVAILABLE","message":...}` for the missing Magnus adapter). Status codes and messages are unchanged. Codes are the suite defaults for the status (`bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `too_large`, `rate_limited`, `unavailable`, `internal`) plus `deployment_adapter_unavailable`, `maintenance` and `archive_digest_mismatch`; `requestId` matches the `x-request-id` header.
- The deployment approval, reconcile and dispatch code (`src/app.ts`, `src/magnus-deployment.ts`, `src/deployment-journal.ts`) is reformatted from single long lines into reviewable statements. Behaviour is unchanged.

- A Magnus deployment whose executor credential cannot be read (or whose Oathweave token cannot be fetched) is marked `failed` ("nothing was dispatched") instead of `unknown`, since no request was sent and there is nothing to reconcile.

### Fixed

- README: SQLite is a native add-on (`@photostructure/sqlite` prebuilds), not built into Node, and the stale "Hive 3.12.3 pins HiveSkills 1.8.1" sentence is replaced by a pointer to the signed suite release manifest.

### Migrations

- `managed-format-4` (fast, additive): a `release_advisories` side table. Release rows are untouched and older binaries (`^1.1.0`) still read and write the data. Run `hive-skills migrate` (or start with `HIVE_AUTO_MIGRATE=true`); suite upgrades need `--allow-migrations`.

- `managed-format-5` (fast, additive): a `release_signatures` side table, likewise readable by older binaries. Installations that skip a release apply both in one migration step.

### Upgrade notes

- A client that sends a JSON body over 64 KiB to a route other than a release upload or a receipt now gets `413`. No HiveSkills route needs one.
- Pinning publisher keys on a host (bridge `HIVE_SKILLS_PUBLISHER_KEYS`) makes it refuse every unsigned release, including those already published and the bundled HiveMem seed. Sign the releases it installs first. Without keys pinned nothing changes.
- A client that read the `error` field as a string must read `error.message` (and may use `error.code`). HiveXUI already parses every suite error shape with `parseHiveError`; the Hermes bridge and Magnus read only status codes.
- Probes or scripts that compared `release` in `/health/live` or `/healthz` with `1.2.2` now see the package version (for example `1.10.0`).
- A registry that receives PAM sign-ins through a reverse proxy sees every client at the proxy's address, so 10 failed sign-ins from anyone would make every sign-in through it wait up to 5 minutes. Set `HIVE_SKILLS_TRUSTED_PROXIES` to the proxy's IP. Oathweave bearer sign-in (suite installations) is not throttled and unaffected.

## [1.9.1] - 2026-11-24

### Added

- `GET /health/live`, `GET /health/ready` and `GET /healthz` report `capabilities: ["skills.pinned-release.v1"]`, so a Magnus without the Hive Registry can tell from the liveness probe that pinned releases are served. The capability list is one constant (`src/capabilities.ts`). Every existing field, status code and header is unchanged.

## [1.9.0] - 2026-11-24

### Added

- Pinned releases (`skills.pinned-release.v1`). `GET /v1/skills/:slug/releases/:version` returns one immutable release by exact version, promoted or not: `sha256`, archive `size`, `notes`, Hermes `compatibility`, the `channels` it is promoted on, `archiveUrl` and `createdAt`. `GET /v1/skills/:slug/releases/:version/archive` now also serves releases that are not promoted, with `X-Content-SHA256`. Both need an enrolled target (`?target=` with its bearer token, the manifest credential, and only for skills the target is assigned) or a registry administrator. Anonymous callers get `401` from the metadata route, and the archive route still answers `404` for anything but the release promoted on the requested channel, which stays public. Releases of a disabled skill are not served. OpenAPI and browser contracts add `PinnedRelease`. No storage change.

### Changed

- The archive route checks the stored bytes against the release digest before serving any archive, the promoted one included, and answers `500` without the bytes when they differ. Agents already verified the digest themselves; a corrupted archive is now refused at the registry too.

## [1.8.1] - 2026-11-15

### Changed

- Require `@hivemagnus/hive-common` 0.5.0. In HiveSkills this changes only the audit export's `details` scrubbing (linear-time, and URL credentials with only a user or only a password are masked) and checks the Oathweave verifier and health settings at startup. Routes, responses and accepted tokens are unchanged.
- The HiveEvent feed is built with the shared `buildFeedPage()` and feed-position helpers, the baseline security headers come from the shared `securityHeaders()` middleware, and the session cookie signature is compared with `timingSafeEqualString()`. Pages, ordering, the 14-day window, cursors (same encoding, so cursors from earlier releases keep working), headers and status codes are unchanged. A feed cursor with extra fields, an ID longer than 256 characters or a control character, none of which this registry writes, is now answered with `400`.

## [1.8.0] - 2026-11-13

### Fixed

- `POST /auth/logout` only revokes and audits a session cookie this registry signed. Previously any unauthenticated request could add a `logout` audit record with a caller-chosen subject. Logout records now name the account that signed out and use `session` as the subject instead of the session id.
- Sign-in attempts with a name no OS account can have no longer occupy the sign-in throttle, so they cannot lock every other account out with `429`. They are still answered with `401`.
- A request body that is not valid JSON is answered with `400` (`Invalid JSON body`) instead of `500`.
- `PUT /admin/targets/:target` with `magnusNodeId: null` clears the link as documented even while agent references are stored; it was rejected with `400` unless `agentRefs: []` was sent first.
- A trailing slash in `HIVE_SKILLS_PUBLIC_URL` is ignored. It produced `//v1/...` archive links that agents refuse as an unexpected archive path.

## [1.7.1] - 2026-11-13

### Security

- Update `@hono/node-server` to 2.1.8 for GHSA-qv5m-9pm6-hqp3 and GHSA-jpvv-r467-5p4w.

## [1.7.0] - 2026-11-12

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
