# HiveSkills

HiveSkills is the Skills registry for agents: a digest-verified HTTPS archive API with immutable releases, release channels, assignments and audited distribution.

It is one product in the [Hive:Magnus](https://github.com/ChefTaco/hive) suite, and it also runs on its own. The [Hive installer](https://github.com/ChefTaco/hive#readme) deploys tested combinations of the suite's products.

This project was extracted from Hive with its migration history and client protocols intact. `provenance.json` records the source revision and original file hashes.

It exposes a digest-verified HTTPS archive API, an OS-authenticated operator page, and a pull-side Hermes bridge. Hermes itself remains unmodified: each host gets a user systemd timer that syncs skill archives into `~/.hermes/skills/registry` and restarts the gateway only when content changes.

The registry is intentionally small and local-first. SQLite records skills, releases, sessions, audit events, and deployment targets; archives live under the configured data directory. The initial catalog entry is **HiveMem**, based on the existing HiveMem Hermes plugin/skill source supplied at seed time.

## Install

HiveSkills 1.3 ships only as a container image, `ghcr.io/cheftaco/hiveskills`, for
`linux/amd64` and `linux/arm64`. Each release is tagged with its exact version (for example
`1.3.1`; there is no `latest` tag), and its
[GitHub release](https://github.com/ChefTaco/HiveSkills/releases) records the image digest.

**With the Hive suite.** HiveSkills is normally installed by `hive.sh`, the
[Hive suite controller](https://github.com/ChefTaco/hive#install-the-suite), in both the
`core` and `full` profiles. The controller pins the image by digest from a signed release
manifest and writes its configuration, secrets and TLS. In the suite, administrators sign in
through Oathweave from HiveXUI ([direct browser authorization](docs/OATHWEAVE.md)). Use a current signed suite release for the reviewed product and datastore pins.

**Legacy npm packages.** HiveSkills 1.3 is not published on npm. The npm package
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
  --env-file skills.env ghcr.io/cheftaco/hiveskills:1.5.0 check
docker run -d --name hiveskills -p 127.0.0.1:4030:4030 -v hiveskills-data:/data \
  -v "$PWD/tls:/config/tls:ro" --env-file skills.env ghcr.io/cheftaco/hiveskills:1.5.0

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
and `pamtester` for OS-backed sign-in. SQLite is provided by Node; there are no native npm
add-ons. Agent deployment also needs Bash, OpenSSH, and permission to enable the target's user
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
```

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

`scripts/deploy-hive-skills.sh` preserves `/opt/hive-skills/shared/.env`, installs the PAM policy and `hive-skills.service`, and activates a health-gated release. New hosts require their own env file; existing hosts retain their own state. `HIVE_SKILLS_ADMIN_USERS` lists the OS accounts allowed to administer the registry (there is no default); authentication is checked through PAM against the host OS account, and the registry stores only a server-side session hash—never an OS password.

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

That installs a `hive-skills-sync` systemd **user** service and timer for the target account. The timer pulls `/v1/agent/manifest` and downloads only changed archives with SHA-256 verification. It never edits Hermes core code. A registry admin can invoke the same deployment from the web page; the server queues a durable deployment job and records its completion status. No target OS password is stored in the network service environment.

Releases may declare `minHermesVersion` and `maxHermesVersion` when published.
The bridge detects the local `hermes --version`, supplies it to the manifest, and
checks the returned range again before installation. Set
`HIVE_SKILLS_HERMES_VERSION` in the target's private bridge environment only when
the Hermes wrapper cannot report its version. A bounded release is omitted when
the target version is missing or incompatible; unbounded existing releases remain
backward compatible. Compatibility is evaluated locally per installation; separate
registry installations do not synchronize Skills state.

## API overview

- `GET /healthz` – unauthenticated readiness (`GET /health/ready` returns the suite-standard body; `GET /health/live` is liveness)
- `GET /v1/skills` / `GET /v1/skills/:slug` – public catalog
- `GET /v1/agent/manifest` – Hermes pull manifest
- `GET /v1/skills/:slug/releases/:version/archive[?channel=canary]` – archive payload, only for the release currently promoted on that channel (default `stable`)
- `POST /auth/login` – PAM-backed OS login
- `POST /admin/skills`, `PATCH /admin/skills/:slug`, `DELETE /admin/skills/:slug`
- `POST /admin/skills/:slug/releases`, `POST /admin/deployments/:target`

Every write and deployment action is audit logged with the authenticated OS username.

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
releases cannot be downloaded. Promoted archives remain public within the
registry's network boundary: target skill lists select distribution, they are
not an archive confidentiality boundary.

A target can optionally be linked to the fleet: `PUT /admin/targets/:name` also
accepts `magnusNodeId` (`[A-Za-z0-9._-]{1,128}`) and `agentRefs`, up to 64 unique
`<magnusNodeId>~<profile>` references on that node. Omitting both keeps the stored
link; `magnusNodeId: null` clears it and `agentRefs: []` clears only the agents.
Linked targets list these fields; unlinked targets are listed exactly as before.
`GET /admin/targets?nodeId=<magnusNodeId>` returns only targets linked to exactly
that node, and `GET /admin/receipts?targetId=<name>` returns only that target's
receipts. Without the parameters both listings are unchanged.

## Releases

Pushing a `v*` tag runs `.github/workflows/release-image.yml`, which runs CI, builds the image
for both architectures, publishes it to `ghcr.io/cheftaco/hiveskills` under its exact version
with a build provenance attestation, and records the digest in a GitHub release.

## Managed upgrades

Use `hive upgrade --dry-run`, then `hive upgrade` for the enrolled release bundle. This server's
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
HTTPS `url`, a protected `credentialFile`, and optional `caFile`. The credential is
a dedicated endpoint-scoped grant configured in Magnus; it cannot run arbitrary
commands or administer the fleet. Each logical registry target must be explicitly
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

The Magnus adapter disables the legacy SSH worker. Existing standalone native
console routes remain available for recovery when the adapter is unconfigured;
interrupted legacy jobs are retained as unknown instead of automatically retried.
Rehearsal mode disables both workers and preserves pending records. Run an explicit
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
