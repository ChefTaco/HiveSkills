# AGENTS.md - HiveSkills

HiveSkills is the Skills registry of the Hive:Magnus suite: an HTTPS API with digest-verified,
immutable skill releases, release channels, target assignments, audited distribution and a
pull-side Hermes bridge. It runs on its own or inside a Hive suite installation, and ships as the
container image `ghcr.io/cheftaco/hiveskills`. This public Apache-2.0 product was extracted from
Hive: preserve LICENSE, NOTICE, provenance.json and the immutable database migration history.

## Privacy

Never commit secrets, private infrastructure, databases, runtime state, local notes or real user
data, in code, tests, docs or commit messages. Use `example.com` hosts and placeholder accounts.
Read `AGENTS.local.md` when present; never copy it into tracked content. Install the hooks
(`npm run hooks:install`, which `npm run bootstrap` also does) and never bypass them; they run
`scripts/check-private-data.sh`, `scripts/scan-secrets.sh` and Gitleaks (see CONTRIBUTING.md).

## No UI here

HiveXUI is the UI for the suite, HiveSkills included. `/` only serves the HiveXUI stub page or a
redirect to `HIVEXUI_URL` (`src/hivexui-stub.ts`). Do not add UI pages or assets. Browser
consumers use the public contracts in `docs/browser-contracts.ts`, never backend code.

## Layout

| Path | What it holds |
| --- | --- |
| `src/app.ts` | Hono app: every HTTP route |
| `src/cli.ts`, `src/server.ts`, `src/config.ts`, `src/env-schema.ts` | CLI entry point (`start`, `seed`, `check`, `env-schema`, `migrate`, `upgrade`, `rollback`), TLS server, configuration |
| `src/identity.ts`, `src/auth.ts`, `src/account-links.ts` | Oathweave verification (audience `hiveskills`), PAM sessions, identity links |
| `src/magnus-deployment.ts`, `src/deployment-*.ts` | Approved deployments through Magnus, the durable job journal, the legacy SSH worker |
| `src/hive-events.ts`, `src/audit-export.ts` | HiveEvent v1 feed and HiveAuditRecord v1 export |
| `src/browser-contracts.ts` | Zod request schemas shared with the browser export |
| `src/migrations/`, `src/schema.ts`, `src/db.ts` | SQLite schema and migrations (immutable history) |
| `src/release/` | Generated at build from `tooling/release` (gitignored) |
| `tooling/release/` | Vendored managed-upgrade and recovery engine, its own npm workspace and tests |
| `scripts/` | Hermes sync bridge, deploy helpers, OpenAPI and browser-contract exporters, privacy and secret scans |
| `registry-sources/hivemem/` | Bundled HiveMem skill used by `seed` |
| `docs/` | `openapi.json`, `browser-contracts.ts` (both checked by CI) and `OATHWEAVE.md` |

## Build and checks

Node.js 24.22.3+ or 26.13.1+. Set up with `npm run bootstrap` (installs the root and
`tooling/release` dependencies, then the hooks). CI runs, and you should run before a PR:

```bash
npm run typecheck
npm run build
npm test              # builds, then node --test over dist/*.test.js and scripts/*.test.mjs
npm run check:openapi # docs/openapi.json matches the routes
npm run check:browser # docs/browser-contracts.ts matches src/browser-contracts.ts
npm run check:doc-versions # documents name only current versions
npm run scan:secrets
npm run check:private
```

After a route or schema change, run `npm run generate:openapi` and `npm run contracts:browser` and
commit the updated snapshots. `tooling/release` has its own tests
(`npm --prefix tooling/release test`). `node dist/cli.js --help` lists the CLI commands.

## Conventions

- Strict TypeScript and runtime validation at every API boundary. Security behaviour needs a
  regression test.
- Keep existing compatibility paths (the legacy SSH deployment route, PAM sign-in, the historical
  `./.env` lookup) unless a change says why they go.
- Database migrations are append-only; never edit a shipped one.
- Conventional Commits. Release by pushing a `vX.Y.Z` tag: `.github/workflows/release-image.yml`
  builds and publishes the image for amd64 and arm64 and records its digest in the GitHub release.
  Nothing is published to npm; `@hivemagnus/hive-skills` on npm is the legacy 1.2.2 line.

## Gotchas

- `npm test` and `npm run build` regenerate `src/release/` from `tooling/release`; run
  `npm run bootstrap` first or the build cannot find esbuild.
- The image has no `pamtester`, so OS-account sign-in works only in source installs; suite
  installations sign in through Oathweave.
- The default data directory (`./data`) is not writable in the image; set `HIVE_SKILLS_DATA_DIR`.
