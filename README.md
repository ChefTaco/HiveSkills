# HiveSkills

HiveSkills is the Skills registry for agents: a digest-verified HTTPS archive API with immutable releases, release channels, assignments and audited distribution.

It is one product in the [Hive:Magnus](https://github.com/ChefTaco/hive) suite, and it also runs on its own. The [Hive installer](https://github.com/ChefTaco/hive#readme) deploys tested combinations of the suite's products.

This project was extracted from Hive with its migration history and client protocols intact. `provenance.json` records the source revision and original file hashes.

It exposes a digest-verified HTTPS archive API, OS-authenticated administration APIs, and a pull-side Hermes bridge. Hermes itself remains unmodified: each host gets a user systemd timer that syncs skill archives into `~/.hermes/skills/registry` and restarts the gateway only when content changes.

HiveSkills no longer ships its own web UI. HiveXUI is the UI for the Hive:Magnus product line,
including HiveSkills. The old UI address (`/`) serves a small static page pointing to HiveXUI or,
when `HIVEXUI_URL` is set, redirects there (`302`).

The registry is intentionally small and local-first. SQLite records skills, releases, sessions, audit events, and deployment targets; archives live under the configured data directory. The initial catalog entry is **HiveMem**, based on the existing HiveMem Hermes plugin/skill source supplied at seed time.

## Install

Since 1.3, HiveSkills ships only as a container image, `ghcr.io/cheftaco/hiveskills`, for
`linux/amd64` and `linux/arm64`. Each release is tagged with its exact version (for example
`1.11.1`; there is no `latest` tag), and its
[GitHub release](https://github.com/ChefTaco/HiveSkills/releases) records the image digest.

**With the Hive suite.** HiveSkills is normally installed by `hive.sh`, the
[Hive suite controller](https://github.com/ChefTaco/hive#install-the-suite), in both the
`core` and `full` profiles. The controller pins the image by digest from a signed release
manifest and writes its configuration, secrets and TLS. In the suite, administrators sign in
through Oathweave from HiveXUI ([direct browser authorization](docs/OATHWEAVE.md)). The signed suite release manifest names the HiveSkills image the
suite pins; this README does not repeat it, so it cannot go stale.

**Legacy npm packages.** HiveSkills 1.3 and later are not published on npm. The npm package
`@hivemagnus/hive-skills` (the name this source still uses), the `@hivemagnus/hive` launcher's
`--services skills` option and the image `ghcr.io/cheftaco/hive-skills` are the legacy 1.x line
from the Hive repository: `npm install` and `npx` resolve `@hivemagnus/hive-skills` to 1.2.2, not
to this release. The [Hive README](https://github.com/ChefTaco/hive#the-retired-npm-packages)
describes that line, and its
[npm migration runbook](https://github.com/ChefTaco/hive/blob/v1.2.2/docs/npm-deployments.md#optional-skills-registry)
covers existing systemd installations of it.

**On its own.** The registry always serves HTTPS, so mount a certificate and key that cover
its public URL and are readable by the container's `node` user (uid 1000):

```bash
umask 077
cat > skills.env <<EOF
NODE_ENV=production
HIVE_AUTO_MIGRATE=true
HIVE_SKILLS_PUBLIC_URL=https://localhost:4030
HIVE_SKILLS_DATA_DIR=/data/skills
HIVE_SKILLS_SESSION_SECRET=$(openssl rand -hex 32)
HIVE_SKILLS_ADMIN_USERS=admin
HIVE_SKILLS_TLS_CERT_FILE=/config/tls/server.crt
HIVE_SKILLS_TLS_KEY_FILE=/config/tls/server.key
NODE_EXTRA_CA_CERTS=/config/tls/server.crt
EOF

docker run --rm -v hiveskills-data:/data -v "$PWD/tls:/config/tls:ro" \
  --env-file skills.env ghcr.io/cheftaco/hiveskills:1.11.1 check
docker run -d --name hiveskills -p 127.0.0.1:4030:4030 -v hiveskills-data:/data \
  -v "$PWD/tls:/config/tls:ro" --env-file skills.env ghcr.io/cheftaco/hiveskills:1.11.1

# Once it reports healthy
curl --cacert tls/server.crt https://localhost:4030/healthz
docker exec hiveskills node dist/cli.js seed    # optional: the bundled HiveMem skill
```

`tls/` holds `server.crt` and `server.key`. `NODE_EXTRA_CA_CERTS` lets the image's health
check, which verifies certificates, trust a self-signed certificate; omit it for a
certificate from a CA the image already trusts. Set `HIVE_SKILLS_DATA_DIR` as shown: the
default, `./data`, is not writable inside the image. The image entry point is the CLI, so its
commands follow the image name. The image does not include PAM (`pamtester`), so the OS-account
sign-in described below is not available in a container; the public catalog, manifest and
archive APIs work without it, and suite installations use Oathweave instead.
[`docker-compose.example.yml`](docker-compose.example.yml) is the Compose example from the
legacy 1.x line and defaults to the `ghcr.io/cheftaco/hive-skills` image.

## CLI and configuration

The CLI (`hive-skills`, or `node dist/cli.js` in the image and in a source build) accepts
`start` (the default), `seed`, `check`, `env-schema`, `migrate`, `upgrade`, `rollback`,
`--help` and `--version`. `check` validates TLS, configuration and an existing database
without creating or migrating state. `env-schema` prints configuration metadata without
loading runtime configuration. Environment-file paths may be absolute; existing environment
variables win. Without `--env-file`, the historical `./.env` lookup is retained. Help/version
do not initialize storage. A fresh install starts with an empty catalog; startup never seeds or
replaces existing records. Run `hive-skills migrate` explicitly before first startup, or enable
`HIVE_AUTO_MIGRATE=true` with backup access.

Outside a container, the server needs Linux, Node.js 24.22.3+ or 26.13.1+, TLS certificates,
and `pamtester` for OS-backed sign-in. SQLite comes from `@photostructure/sqlite`, a native
add-on that ships prebuilt binaries for Linux (glibc and musl, x64 and arm64) and loads them with
Node-API, so `npm ci` needs no compiler and one build runs on both Node 24 and Node 26. Agent deployment also needs Bash, OpenSSH, and permission to enable the target's user
timer.

Configure these values in a private environment file (mode 0600):

```dotenv
NODE_ENV=production
HIVE_SKILLS_HOST=127.0.0.1
HIVE_SKILLS_PORT=4030
HIVE_SKILLS_PUBLIC_URL=https://hive.example.com:4030
HIVE_SKILLS_DATA_DIR=/opt/hive-skills/shared/data
HIVE_SKILLS_SESSION_SECRET=replace-with-at-least-32-random-characters
HIVE_SKILLS_ADMIN_USERS=admin
HIVE_SKILLS_PAM_SERVICE=login
HIVE_SKILLS_TLS_KEY_FILE=/opt/hive-skills/tls/server.key
HIVE_SKILLS_TLS_CERT_FILE=/opt/hive-skills/tls/server.crt
# Optional: redirect the retired web UI address to HiveXUI.
HIVEXUI_URL=https://hivexui.example.com/
```

`HIVEXUI_URL` is optional. When set, it must be an absolute `http` or `https` URL without
credentials or a fragment, or startup fails. Requests for the retired web UI path (`/`) are then
redirected (`302`) to exactly that URL; the request path is not appended. When unset, `/` serves a
static page that tells operators to open HiveXUI. All API routes are unaffected either way.

Generate the session secret with `openssl rand -hex 32`. Configure a bind address suitable
for the network where the registry is exposed and a certificate covering its public URL.
The service account needs write access to the data directory and read access to its TLS files.
Keep the session secret unchanged on upgrades to preserve active sessions.

The deployment helper is selected automatically; set `HIVE_SKILLS_DEPLOY_SCRIPT` only for an
intentional override. `scripts/hermes-sync.mjs`, `scripts/archive-utils.mjs`,
`scripts/deploy-hermes-agent.sh` and the bundled seed source work independently of the process
working directory.

## Bring up the registry server

```bash
cp .env.example .env
# Set a real session secret and the certificate/key paths already managed by the server.
npm install
npm run build
HIVE_SKILLS_DEPLOY_HOST=hive.example.com HIVE_SKILLS_ENV_FILE="$PWD/.env" bash scripts/deploy-hive-skills.sh
```

The service listens on a dedicated TLS port (default `4030`) and does not mint certificates itself. It uses the server's existing certificate and key specified in `.env`.

`HIVE_SKILLS_SESSION_SECRET` (at least 32 characters) is required. Only a non-production instance bound to a loopback address falls back to an ephemeral random secret, with a warning; its sessions end on restart.

`scripts/deploy-hive-skills.sh` preserves `/opt/hive-skills/shared/.env`, installs the PAM policy and `hive-skills.service`, and activates a health-gated release. New hosts require their own env file; existing hosts retain their own state. `HIVE_SKILLS_ADMIN_USERS` lists the OS accounts allowed to administer the registry (there is no default); authentication is checked through PAM against the host OS account, and the registry stores only the SHA-256 of each session id, never an OS password.

Sign-in is throttled, not locked out: after a failed attempt an account waits 15 seconds, and one
client address (an IPv6 client counts by its /64) may fail at most 10 times in 5 minutes across all
accounts (`429` with `Retry-After`). Configure PAM `faillock` (or the host's equivalent) for the real
account lockout. Behind a reverse proxy, list it in `HIVE_SKILLS_TRUSTED_PROXIES` (comma-separated IP
addresses, CIDR ranges such as `10.0.0.0/8`, or `loopback`, `private`, `linklocal`) so the client
address is taken from `X-Forwarded-For` (ports are ignored); from any other peer that header is
ignored.
Every refused sign-in is audited as `login.failed` (exported as `session.login_failed`) with the
account, client address and throttle state.

## Seed HiveMem

The bundled `registry-sources/hivemem` skill is the initial registry entry and documents the existing HiveMem plugin/tools. Seed it after build:

```bash
npm run seed
```

With the container image, run `docker exec hiveskills node dist/cli.js seed`.

The command validates and archives the bundled source as `hivemem` release `1.0.0` and promotes it to stable. Set `HIVEMEM_ARCHIVE` to seed a separately packaged replacement instead. Releases are immutable; later release and catalog CRUD operations are available to the OS-admin through the API.

## Hermes compatibility

Install the client bridge on an agent host using its own SSH key and explicit target settings:

```bash
HIVE_SKILLS_PUBLIC_URL=https://hive.example.com:4030 \
HIVE_SKILLS_TARGET_HOST=agent-host.example.com \
HIVE_SKILLS_TARGET_USER=deploy \
  scripts/deploy-hermes-agent.sh --target agent-1
```

That installs a `hive-skills-sync` systemd **user** service and timer for the target account. The timer pulls `/v1/agent/manifest` and downloads only changed archives with SHA-256 verification. It never edits Hermes core code. A registry admin can invoke the same deployment through the administration API (for example from HiveXUI); the server queues a durable deployment job and records its completion status. No target OS password is stored in the network service environment.

Releases may declare `minHermesVersion` and `maxHermesVersion` when published.
The bridge detects the local `hermes --version`, supplies it to the manifest, and
checks the returned range again before installation. Set
`HIVE_SKILLS_HERMES_VERSION` in the target's private bridge environment only when
the Hermes wrapper cannot report its version. A bounded release is omitted when
the target version is missing or incompatible; unbounded existing releases remain
backward compatible. Compatibility is evaluated locally per installation; separate
registry installations do not synchronize Skills state.

## API overview

`docs/openapi.json` is the full route and schema snapshot (`npm run check:openapi` keeps it in
step with the code).

- `GET /` – retired web UI: a static page pointing to HiveXUI, or a `302` to `HIVEXUI_URL` when set
- `GET /healthz` – unauthenticated readiness (`GET /health/ready` returns the suite-standard body; `GET /health/live` is liveness). All three bodies list `capabilities`, the suite service capabilities this build provides (`skills.pinned-release.v1`, `skills.revocations.v1`, `skills.transparency-log.v1`)
- `GET /v1/skills` / `GET /v1/skills/:slug` – public catalog
- `GET /v1/agent/manifest` – Hermes pull manifest; `POST /v1/agent/receipts/:target` – the bridge's install receipt
- `GET /v1/skills/:slug/releases/:version/archive[?channel=canary]` – archive payload with `X-Content-SHA256`; public only for the release currently promoted on that channel (default `stable`), any other release needs a pinned-release reader (see below)
- `GET /v1/skills/:slug/releases/:version` – metadata of one release by exact version for a pinned-release reader
- `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` – PAM-backed OS sign-in and the current session
- `GET /admin/skills`, `POST /admin/skills`, `PATCH /admin/skills/:slug`, `DELETE /admin/skills/:slug`
- `GET /admin/skills/:slug/releases`, `POST /admin/skills/:slug/releases` – a release upload is JSON
  with `archiveBase64`, or the raw archive as `Content-Type: application/gzip` with `version`,
  `notes`, `minHermesVersion` and `maxHermesVersion` in the query string
- `GET /admin/channels`, `PUT /admin/channels/:channel/:slug` (promote), `DELETE /admin/channels/:channel/:slug` (withdraw)
- `PUT /admin/skills/:slug/releases/:version/advisory` (`{"level":"deprecated"|"yanked","reason"}`), `DELETE` the same path – an advisory notice on an immutable release: it stays downloadable and promoted where it is, pinned-release metadata reports it as `advisory`, its archive carries `X-Release-Advisory`, and a yanked release cannot be promoted again. Withdraw it from its channels to stop distribution
- `GET /admin/targets`, `PUT /admin/targets/:name`, `POST /admin/targets/:name/enroll`, `GET /admin/receipts`
- `GET /admin/deployments`, `GET /admin/deployments/capabilities`, `POST /admin/deployments/:target`,
  `GET /admin/deployments/jobs/:id`, `POST /admin/deployments/jobs/:id/approve`, `POST /admin/deployments/jobs/:id/reconcile`
- `GET /admin/audit`, `GET /admin/updates`
- `GET /v1/revocations`, `PUT /admin/revocations`, `GET /v1/transparency/head`, `GET /v1/transparency/entries`, `GET /admin/signatures` – revocation lists, the transparency log and the signature overview (see "Revocations" and "Transparency log" below)
- `GET /v1/hive/events` and `GET /v1/audit/export` – see below

Every write and deployment action is audit logged with the authenticated OS username.

Errors use the suite envelope, `{"error":{"code":"not_found","message":"Skill not found","requestId":"..."}}`,
where `requestId` matches the `x-request-id` response header.

Request bodies are limited while they stream: 70 MiB for a JSON release upload, 50 MiB for a raw
`application/gzip` one, 1 MiB for a signed revocation list, 256 KiB for an agent receipt and 64 KiB for everything else, the sign-in
included. A larger body is answered with `413`.

Skills is optional; each registry installation is independent.

Deployment targets can be seeded at startup with `HIVE_SKILLS_TARGETS`, a
comma-separated list of `name=user@host` entries (for example
`agent-1=deploy@agent-host.example.com`). Manage them afterwards with `GET /admin/targets` and `PUT /admin/targets/:name`
(`host`, `username`, `enabled`). Changing a target host/account or disabling it
revokes its pull enrollment. Enroll again to assign a channel and optional skill
list. Preserve `~/.config/hive-skills/bridge.env` on that target for its own
`HIVE_SKILLS_TARGET` and `HIVE_SKILLS_TARGET_TOKEN`; the installer reads this
optional file without replacing it. The manifest of a canary-enrolled target
points at channel-scoped archive URLs. Unpromoted, superseded and withdrawn
releases cannot be downloaded anonymously. Promoted archives remain public within the
registry's network boundary: target skill lists select distribution, they are
not an archive confidentiality boundary.

### Pinned releases

Releases are immutable, so a definition can pin a skill to an exact version and
digest (`skills.pinned-release.v1`). `GET /v1/skills/:slug/releases/:version`
returns `slug`, `version`, `sha256`, `size` (bytes, `null` if the stored archive
is missing), `notes`, `compatibility` (`minHermesVersion`, `maxHermesVersion`),
`channels` (where this version is promoted now), `archiveUrl` and `createdAt`.
`GET /v1/skills/:slug/releases/:version/archive` then serves that exact release
whether or not it is promoted. Both need a pinned-release reader:

- an enrolled target: `?target=<name>` with `Authorization: Bearer <target token>`,
  the same credential as the manifest and receipts; a target enrolled with a skill
  list gets `403` for other skills; or
- a registry administrator (OS session or linked Oathweave identity).

Anonymous callers get `401` from the metadata route, and the archive route keeps
answering `404` for anything but the promoted release. Releases of a disabled or
deleted skill are not served. Every archive, promoted or pinned, is checked
against its release digest before it is sent; a stored file that no longer
matches is refused with `500` and never served.

A target can optionally be linked to the fleet: `PUT /admin/targets/:name` also
accepts `magnusNodeId` (`[A-Za-z0-9._-]{1,128}`) and `agentRefs`, up to 64 unique
`<magnusNodeId>~<profile>` references on that node. Omitting both keeps the stored
link; `magnusNodeId: null` clears it and `agentRefs: []` clears only the agents.
Linked targets list these fields; unlinked targets are listed exactly as before.
`GET /admin/targets?nodeId=<magnusNodeId>` returns only targets linked to exactly
that node, and `GET /admin/receipts?targetId=<name>` returns only that target's
receipts. Without the parameters both listings are unchanged.

### Automatic canary promotion and rollback

Both rules are off by default and act only on the canary channel's current release, judged by the
receipts canary targets send:

- `HIVE_SKILLS_CANARY_PROMOTE_AFTER=N` promotes the canary release to stable once `N` distinct
  canary targets report it (exact version and digest) `activated`. A release with an advisory is
  never promoted automatically.
- `HIVE_SKILLS_CANARY_AUTO_ROLLBACK=true` puts canary back on the stable release when a canary
  target reports `restart_failed` with the canary release installed by the activation that failed,
  or withdraws canary when stable has no release of that skill. Skills that were already running on
  that target are left alone.

The Hermes bridge reports both outcomes. After installing changed skills it restarts the gateway
and, when the gateway was running, checks that it is still active, and was not restarted again by
systemd, after a settle delay (`HIVE_SKILLS_RESTART_SETTLE_MS` in the bridge environment, default
`10000`). Only then does it send `activated`; otherwise it sends `restart_failed`, keeps the restart
pending for its next run and exits with an error. Both receipts carry `changed`, the skills
installed since the gateway last restarted cleanly, and rollback acts only on those. A custom agent
that sends `restart_failed` without `changed` triggers no rollback.

Each change is audited with the actor `system` and appears in the event feed as
`skill.release.promoted` or `skill.release.withdrawn`, saying it was automatic.

### Publisher-signed releases

A digest in the manifest proves only that an archive is what the registry serves. To make agent
hosts trust a publisher instead of the registry, sign each release with an Ed25519 key that never
reaches the registry host:

```bash
node scripts/sign-release.mjs keygen --out publisher.pem --key-id example-2026
# prints {"keyId":"example-2026","publicKey":"<base64url>"}
node scripts/sign-release.mjs sign --key publisher.pem --key-id example-2026 \
  --slug my-skill --version 1.2.0 --archive my-skill-1.2.0.tgz
# prints {"keyId","signature","sha256"}
```

The signature covers `hiveskills-release-signature-v1\n<slug>\n<version>\n<sha256>\n`. Upload it
with the release (`signatureKeyId` and `signature`, in the JSON body or the raw upload's query
string), or attach it to an existing release with
`PUT /admin/skills/:slug/releases/:version/signature` (`{"keyId","value"}`); the release itself never
changes. The registry checks every signature against `HIVE_SKILLS_PUBLISHER_KEYS`
(`[{"keyId","publicKey"}]`) and, with `HIVE_SKILLS_REQUIRE_SIGNED_RELEASES=true`, refuses unsigned
uploads. Pinned-release metadata and the admin release list report `signature`.

On an agent host, set the same `HIVE_SKILLS_PUBLISHER_KEYS` in the bridge's private environment
(`~/.config/hive-skills/bridge.env`). The bridge then reads each release's signature from the
pinned-release metadata with its target token and refuses the whole sync, before downloading or
activating anything, unless every release it is about to install is signed by a pinned key. A
compromised registry or administrator session can no longer push code the publisher did not sign.
This needs an enrolled target (`HIVE_SKILLS_TARGET` and its token) and applies to Magnus-approved
publications too. The bundled HiveMem seed is unsigned: sign it, or any other existing release,
before pinning keys on hosts that install it.

Pinning keys does not by itself remove skills a host installed before: the bridge also checks every
installed skill's release (once per release and key; the result is kept in its state file) and, by
default, only reports an unsigned one on stderr (the sync journal) while it stays active. Set
`HIVE_SKILLS_UNSIGNED_INSTALLED=quarantine` in the bridge environment to move such skills out of
the gateway's skills directory (to `~/.hermes/.hive-skills-sync/<slug>.quarantined`), restart the
gateway and fail the sync; from then on they are refused like any unsigned release until the
release is signed. On the registry, `HIVE_SKILLS_REQUIRE_SIGNED_RELEASES=true` refuses new unsigned
uploads but leaves existing releases and their channels as they are.

### Revocations

A signature stays valid after its key leaks, and a release stays signed after it turns out to be
bad. A signed revocation list withdraws that trust. It is signed by a revocation authority key that
is pinned separately from the publisher keys (`HIVE_SKILLS_REVOCATION_KEYS`, same
`[{"keyId","publicKey"}]` format), so the registry and an administrator session can no more forge a
revocation than a release. Keep that key offline, like the publisher keys:

```bash
node scripts/sign-release.mjs keygen --out revocations.pem --key-id revocations-2026
cat > revocations.json <<'JSON'
{"sequence": 2, "expiresAt": "2027-01-31T00:00:00Z",
 "keys": [{"keyId": "example-2026", "publicKey": "<base64url>", "reason": "Key exposed in a CI log"}],
 "releases": [{"slug": "my-skill", "version": "1.2.0", "sha256": "<digest>", "reason": "Ships a broken hook"}]}
JSON
node scripts/sign-release.mjs sign-revocations --key revocations.pem --key-id revocations-2026 \
  --list revocations.json > signed-revocations.json
curl --fail -X PUT -H 'content-type: application/json' --data @signed-revocations.json \
  -b "hive_skills_session=..." https://skills.example.com/admin/revocations
```

The signature covers `hiveskills-revocation-list-v1\n<payload>`, where the payload is the exact JSON
string served by `GET /v1/revocations` (`schema`, `sequence`, `issuedAt`, `expiresAt`, `keys`,
`releases`; `sign-revocations` fills in the schema, `issuedAt` and any missing `revokedAt`). Each
list replaces the previous one, so carry earlier entries forward, and `sequence` must grow: the
registry refuses a list whose sequence is not above the current one, an expired one and one not
signed by a pinned revocation key (`503` when no revocation key is configured). A release is
revoked by slug and version and also by its digest, so the same archive cannot return under another
version or skill; a key is revoked by its public key, whatever id names it. The registry records the
public key that made each stored signature, so the releases of a revoked key are still recognised
after that key is removed from `HIVE_SKILLS_PUBLISHER_KEYS`. On publication the
registry withdraws from their channels every revoked release and every release signed by a pinned
key the list revokes (audited as automatic `release.withdraw` by `system`, shown in the event feed).
From then on it refuses to promote, upload or re-upload a revoked release (checked again in the
transaction that stores it), to promote a release signed by a revoked key, and new signatures by a
revoked key. Re-sign the releases of a revoked key with a new key (`PUT .../signature`), then promote
them again. Lists are append-only in the database and every list is recorded in the transparency
log. `GET /v1/revocations` (the current list) and `GET /v1/revocations/<sequence>` (any earlier one)
are readable by enrolled targets (`?target=` with the target token) and registry administrators.

On an agent host, set `HIVE_SKILLS_REVOCATION_KEYS` in `~/.config/hive-skills/bridge.env` (it needs an
enrolled target). On every run, so every 15 minutes with the installed timer and always before
anything is activated, the bridge then reads the list and verifies its signature. It fails the sync
closed, activating nothing, when the registry serves no list, an unverifiable one, one older than the
highest sequence it has seen (kept in its state file), a different list under a sequence it has seen,
or one past its `expiresAt`. Publish an initial list (it may be empty) before pinning revocation keys
on hosts, and when you set `expiresAt`, publish a fresh list before it passes: expiry is what stops a
compromised registry from freezing hosts on an old list. The highest sequence seen lives in the
bridge's state file; to keep a lost or deleted state file from opening a rollback, also set
`HIVE_SKILLS_MIN_REVOCATION_SEQUENCE` in `bridge.env` to a sequence the host must never go below (raise
it as you publish). A revoked release, or one whose only valid signature is by a revoked publisher
key (with `HIVE_SKILLS_PUBLISHER_KEYS` pinned), is refused before download. The bridge checks both
what the manifest offers and what each installed skill actually runs (the version and digest it
recorded at installation), matching by digest as well, so a registry cannot keep revoked bytes
running by relabelling them. Each installed skill is also checked against the key that verified it,
whatever version the manifest now offers: an installed release whose signing key is revoked stays
revoked unless the registry serves a fresh valid signature of the same bytes by an unrevoked key, and
withholding the signature does not make it merely "unsigned". These installed skills are dealt with
before anything the manifest offers can fail the sync (an unusable manifest, a refused new version,
unreadable release metadata), and a revoked installed skill never excuses a new version of it from
its own signature check. Installed revoked ones are quarantined (moved to `~/.hermes/.hive-skills-sync/<slug>.quarantined`,
gateway restarted, sync failed) unless `HIVE_SKILLS_REVOKED_INSTALLED=report`, which keeps them
active and logs them. The bridge reports what it did in its receipt: status `revoked` with
`revocations: [{slug, version, reason: "release"|"key", keyId?, action: "refused"|"quarantined"|"reported"}]`
when it refused or quarantined, or the same list on an `activated` receipt in report mode.

### Transparency log

Every release publication (`release.published`), every signature attached later
(`release.signed`), every revocation list (`revocations.published`: its sequence, payload digest and
signature; the payload is served by `GET /v1/revocations/<sequence>`) and every skill deletion with
the releases it removed (`skill.deleted`) is appended to an append-only, hash-chained log in the same
database transaction as the change it records. A version the log has ever recorded can never be
uploaded again, even after its skill was deleted (`409`): releases are immutable. On every start the
registry records whatever was stored without an entry (releases from before the log existed, or
written by a restored backup), marked `backfilled`, and withdraws revoked releases again; a registry
that cannot do so refuses to start. Each entry is the
exact JSON string `{"v":1,"index","previousHash","kind","recordedAt","subject"}`; its hash is the
SHA-256 of `hiveskills-transparency-entry-v1\n<entry>`, `previousHash` links it to the entry before
(64 zeros for the first), and the registry's log key signs
`hiveskills-transparency-log-v1\n<index>\n<hash>\n` for every entry and
`hiveskills-transparency-head-v1\n<size>\n<headHash>\n<signedAt>\n<logKeyId>\n` for the head. The
database refuses to update or delete an entry.

The log key is created on first use in the data directory (`transparency-log-key.pem`, mode `0600`,
or `HIVE_SKILLS_TRANSPARENCY_KEY_FILE`); the registry refuses to start using a key file that group or
others can read. Data-directory backups therefore hold the log's private key: protect them like the
key. Pin the public key (in `GET /v1/transparency/head`) where you verify. To rotate the key (for
example after a backup leaked), point `HIVE_SKILLS_TRANSPARENCY_KEY_FILE` at a new path (the key is
created there) or replace the file, restart, and pin both keys (`--log-key` twice) on verifiers: later
entries and every head are signed by the new key, earlier entries keep the old key's signatures.

Storage format `managed-format-6` is readable only by HiveSkills 1.12.0 and later: an older binary
would store and promote releases without the log or revocation checks, so it refuses this data.
Roll back by restoring the backup the upgrade took.

`GET /v1/transparency/head` serves the signed head and `GET /v1/transparency/entries?from=<index>&limit=<1-500>`
the entries (a page also ends after about 4 MiB of entries; follow `nextFrom`), to enrolled targets and
registry administrators. Verify the whole log end to end, online or from a saved copy:

```bash
HIVE_SKILLS_TARGET=agent-1 HIVE_SKILLS_TARGET_TOKEN_FILE=target-token \
  node scripts/verify-transparency-log.mjs --registry https://skills.example.com \
    --log-key <base64url> --publisher-keys "$PUBLISHER_KEYS" --revocation-keys "$REVOCATION_KEYS" \
    --known-head 41:<hash> --max-head-age 3600 [--page-size 100] --save log.json
node scripts/verify-transparency-log.mjs --file log.json --log-key <base64url>
```

It checks every link, entry signature and the head signature (with its time and key id), that no
release was published twice or changed its digest, that deletions name releases that were published,
that revocation sequences grow, every revocation payload against its logged digest (it fetches them
and `--save` keeps them), and, given the keys, every publisher signature and revocation list. `--max-head-age SECONDS` refuses a head signed longer ago than that,
so a registry cannot keep serving an old head. `--known-head SIZE:HASH` (printed as `knownHead` by the previous run)
proves the log only grew since. It prints a JSON summary with any warnings (for example a signature
by a key you did not pass) and exits `1` on any failure. An administrator's Oathweave token can be
used instead of a target with `HIVE_SKILLS_BEARER_FILE`.

`GET /admin/signatures` (registry administrators) returns, in one read, the pinned publisher and
revocation keys, every release (up to 1000, newest first) with its status (`verified`, `unsigned`,
`unknown_key`, `invalid`, `revoked_key` or `revoked`), the current revocation list and the log head.
HiveXUI shows it on its signatures screen.

### Event feed

`GET /v1/hive/events?after=<cursor>&limit=<n>` serves HiveEvent v1 events for the
HiveXUI inbox, oldest first, from the last 14 days. It needs the same registry
administrator access as `GET /admin/receipts` (Oathweave tokens need `hiveskills:read`).
Events are derived from stored records: deployment jobs that completed (`info`),
failed (`critical`), expired before dispatch (`info`) or need reconciling (`warning`);
a target's latest receipt reporting a failed agent restart (`warning`); and audited
release publication and promotion (`info`), channel withdrawal and skill deletion
(`warning`). Events about a fleet-linked target carry its Magnus node and, when the
target names exactly one, its agent. `limit` is 1 to 200 (default 50); a malformed
cursor or limit returns 400. Pass `nextCursor` as `after`; `null` means caught up.

### Audit export

`GET /v1/audit/export?after=<cursor>&limit=<n>` serves every stored registry audit
record as a HiveAuditRecord v1 (`{"data":[...],"nextCursor":...}`), oldest first by
id, for the Cindertrace audit collector. There is no retention window. It accepts an
Oathweave service (client-credentials) token for the `hiveskills` audience whose
permissions include **`hiveskills:audit:read`**, or a registry administrator (session
or linked Oathweave user, as for `GET /admin/audit`). Other callers get 403; a
request without credentials gets 401. Set `OATHWEAVE_NATIVE_ISSUERS` when the service
client's tokens are signed with Oathweave's native issuer.

Actions are `session.login`, `session.logout`, `skill.create`, `skill.update`,
`skill.delete`, `release.create`, `release.promote`, `release.withdraw`,
`release.seed`, `target.update`, `target.enroll`, `deployment.prepare`,
`deployment.queue`, `deployment.approve` and `deployment.reconcile`. Records about a
deployment target carry its fleet link in `subject` (`nodeId`, and `agentRef` when
the target names exactly one agent). `details` holds redacted flat scalars only (at
most 4 KB); session ids and archive contents are never exported. `limit` is 1 to 200
(default 100); a malformed cursor or limit returns 400. Pass `nextCursor` as `after`.
It is the last record's cursor even on the final page, so store it and poll it again
later; it is `null` only when `data` is empty (caught up). `GET /admin/audit` is unchanged.

## Releases

Pushing a `v*` tag runs `.github/workflows/release-image.yml`, which runs CI, builds the image
for both architectures, publishes it to `ghcr.io/cheftaco/hiveskills` under its exact version
with a build provenance attestation, and records the digest in a GitHub release.

## Managed upgrades

A Hive suite installation upgrades HiveSkills with the suite controller (`./hive.sh upgrade`; see
the [Hive README](https://github.com/ChefTaco/hive#upgrading)). The rest of this paragraph is for
installations enrolled with the retired npm `hive` launcher: use `hive upgrade --dry-run`, then
`hive upgrade` for the enrolled release bundle. This server's
`upgrade` and `rollback` commands delegate to the same owner-run launcher. `migrate --plan --json`
is read-only; migration requires a verified backup. Set `HIVE_AUTO_MIGRATE=true` explicitly for
startup migrations outside a managed install. Slow or one-way automatic migrations are refused.
`check --json` reports configuration without initializing state. No upgrade rotates signing keys
or reseeds existing accounts. See [UPGRADING.md](https://github.com/ChefTaco/hive/blob/v1.2.2/UPGRADING.md)
for adoption, compatibility, recovery, update notices and container controls.

Container probes use a loopback `HIVE_HEALTH_URL`. Override its port/protocol for
the selected deployment. When the service certificate uses a DNS name, set
`HIVE_HEALTH_TLS_NAME` to that name and `NODE_EXTRA_CA_CERTS` to the approved CA
bundle when needed. Probes retain certificate verification. Runtime state belongs
in `/data`; mount only product-owned protected configuration in `/config`.

### Approved deployments through Magnus

Suite browser deployments require `HIVE_SKILLS_MAGNUS_EXECUTOR_JSON` with a verified
HTTPS `url`, optional `caFile`, and at least one way to authenticate:

- `oathweave` (preferred): `{ "tokenUrl", "clientId", "clientSecretFile", "audience", "scope"? }`,
  this registry's own Oathweave client. HiveSkills then sends short-lived `client_credentials`
  tokens bound to `audience`, cached and refreshed before they expire, and after a `401` it fetches
  a new token and retries once. The client secret file has the same protection rules as
  `credentialFile` and is read at first use; rotating it takes a restart.
- `credentialFile` (deprecated): a protected file (owned by the service user, mode 0600) holding a
  long-lived bearer, a dedicated endpoint-scoped grant configured in Magnus; it cannot run
  arbitrary commands or administer the fleet.

With both, HiveSkills uses the Oathweave token and falls back to `credentialFile`, once per request,
only when no token can be obtained (the token endpoint is down, the secret file is unreadable) or
when Magnus still refuses the token with `401` or `403` (a Magnus without Oathweave support for the
executor routes, or a client it has not linked). Magnus gives those answers before it admits a job,
so the fallback never dispatches a job twice; no other answer or network failure is retried. Each
fallback logs a warning. Configure both while moving a registry to Oathweave, then remove
`credentialFile` (and the static grant in Magnus) once the warnings stop.

A Magnus release that accepts Oathweave tokens on its HiveSkills executor routes (the first one after 3.6.0) accepts this registry's token when:

- the Oathweave client's tokens have audience `magnus` (set `"audience": "magnus"`) and the
  permission `magnus:hiveskills`, from the issuer Magnus verifies (`OATHWEAVE_ISSUER`, normally the
  browser issuer, so the client's machine policy selects it);
- Magnus links the client in `MAGNUS_OATHWEAVE_IDENTITIES_JSON` with role `HIVESKILLS_SERVICE`, the
  client ID as `subject` and this registry's ID in `MAGNUS_HIVESKILLS_DEPLOYMENTS_JSON` as
  `localUserId`.

```json
{"url":"https://magnus.example.com","caFile":"/config/skills-executor-ca.pem",
 "oathweave":{"tokenUrl":"https://identity.example.com/api/v1/oauth/token","clientId":"hiveskills-executor",
   "clientSecretFile":"/config/skills-executor-client-secret","audience":"magnus","scope":"magnus:hiveskills"},
 "credentialFile":"/config/skills-executor"}
```

A job whose credential cannot be obtained is marked failed without being dispatched. Each logical registry target must be explicitly
mapped to an enrolled Magnus node and a configured native agent target. Host-native
credential files and the pinned HiveSkills sync client are installed by the host
installer, independently of the application container.

Prepare an exact publication preview, review its releases and digest, then approve
it once within five minutes using recent authentication. The registry persists
approval before dispatch. The owning agent verifies immutable archive digests,
origin, compatibility and the existing native target credential. Magnus retains
the signed native outcome under the original durable job ID. An interrupted or
unknown operation is reconciled through that original receipt and never replayed
under a new ID. A queued approval that expires cannot dispatch.

The Magnus adapter disables the legacy SSH worker. The existing standalone deployment
route (`POST /admin/deployments/:target`) remains available for recovery when the adapter is
unconfigured; interrupted legacy jobs are retained as unknown instead of automatically retried.
Rehearsal mode (`HIVE_REHEARSAL=true`) disables both workers and preserves pending records;
`HIVE_SKILLS_DEPLOYMENT_WORKER_ENABLED=false` does the same outside a rehearsal. Run an explicit
backed-up `hive-skills migrate` before starting the new schema on existing state.


To prepare a native client artifact for a tested Hive release, run:

```bash
node scripts/build-native-client.mjs --output /protected/new-client-artifact \
  --url https://artifacts.example.com/hiveskills-client-1.2.2.tar.gz \
  --node-version v24.22.3
```

The exporter accepts only unchanged tracked client modules, LICENSE and NOTICE.
Its private output includes an archive and `nativeClients.hiveskills` metadata
with exact archive/file SHA-256 digests and a tested Node version. It never reads
profiles or deployment environments and does not publish anything. Release
maintainers must review the metadata and include it in a publisher-signed Hive
manifest before an operator stages it. Node remains an explicitly selected,
existing root-owned host prerequisite; the archive does not install a runtime.

Browser contract consumers pin the reviewed `docs/browser-contracts.ts` candidate
artifact by version and SHA256. `npm run contracts:browser` exports only the pure
product-owned Zod module; `npm run check:browser` verifies source/export drift.
The backend validates registry writes using the same request schemas. OpenAPI
records these request and response shapes, while the standalone export preserves
all Zod validation and normalization. Publication is a separate release action.

## Native deployment runtime checks

Source deployment checks the Node.js used by npm and `/usr/bin/node`, which the
installed systemd service uses, against the current package `engines.node` policy.
An unsupported runtime stops deployment before remote writes or service restarts.
Update the system interpreter as well as any shell-specific Node.js installation.
