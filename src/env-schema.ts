import { commonEnv } from './release/runtime.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { packageRoot } from './paths.js';

/** Safe to call before configuration is loaded; contains no runtime values. */
export function envSchemaDocument(): unknown {
  const { version } = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as { version: string };
  return {
    service: 'skills', package: '@hivemagnus/hive-skills', version, defaultPort: 4030,
    healthPath: '/healthz', consolePath: '/', dependencies: [],
    env: [...commonEnv(),
      { name: 'NODE_ENV', default: 'production', description: 'Runtime environment.' },
      { name: 'HIVE_SKILLS_HOST', default: '127.0.0.1', description: 'Listener bind address.' },
      { name: 'HIVE_SKILLS_PORT', default: '4030', description: 'HTTPS listener port.' },
      { name: 'HIVE_SKILLS_PUBLIC_URL', default: 'https://localhost:4030', description: 'Public HTTPS registry URL used in archive links.' },
      { name: 'HIVE_SKILLS_DATA_DIR', default: './data', description: 'SQLite database and immutable skill archives.' },
      { name: 'HIVE_SKILLS_SESSION_SECRET', required: true, secret: true, generate: 'hex32', description: 'Session signing secret; at least 32 characters.' },
      { name: 'HIVE_SKILLS_ADMIN_USERS', description: 'Comma-separated OS accounts allowed to administer the registry; independent of IAM.' },
      { name: 'HIVE_SKILLS_PAM_SERVICE', default: 'hive-skills', description: 'Installed PAM policy for OS authentication; use login for a standard Linux policy.' },
      { name: 'HIVE_SKILLS_TLS_KEY_FILE', required: true, description: 'TLS private-key PEM file.' },
      { name: 'HIVE_SKILLS_TLS_CERT_FILE', required: true, description: 'TLS certificate PEM file.' },
      { name: 'HIVE_SKILLS_DEPLOY_SCRIPT', description: 'Optional override for the bundled agent deployment helper.' },
      { name: 'HIVE_SKILLS_MAGNUS_EXECUTOR_JSON', description: 'Optional verified HTTPS executor URL, optional caFile, and exactly one of a protected credentialFile (long-lived bearer) or oathweave {tokenUrl, clientId, clientSecretFile, audience, scope?} (short-lived client-credentials tokens). Enables approved Magnus jobs and disables legacy SSH execution.' },
      { name: 'HIVEXUI_URL', description: 'Optional absolute http(s) HiveXUI URL. When set, the retired web UI path / redirects there; otherwise it serves a page pointing to HiveXUI.' },
      { name: 'HIVE_SKILLS_TRUSTED_PROXIES', description: 'Optional comma-separated reverse-proxy IP addresses. From these peers the sign-in throttle takes the client address from X-Forwarded-For.' },
      { name: 'HIVE_SKILLS_PUBLISHER_KEYS', description: 'Optional JSON array of publisher keys, [{"keyId","publicKey"}] with base64url raw Ed25519 public keys. Release signatures are verified against them at upload.' },
      { name: 'HIVE_SKILLS_REQUIRE_SIGNED_RELEASES', default: 'false', description: 'When true, refuse release uploads without a valid publisher signature. Needs HIVE_SKILLS_PUBLISHER_KEYS.' },
      { name: 'HIVE_SKILLS_CANARY_PROMOTE_AFTER', description: 'Optional 1-1000. Once this many distinct canary targets report the exact canary release activated, promote it to stable.' },
      { name: 'HIVE_SKILLS_CANARY_AUTO_ROLLBACK', default: 'false', description: 'When true, a canary target reporting restart_failed with the canary release, which that failed activation installed (the receipt\'s changed list), puts canary back on the stable release (or withdraws canary when stable has none).' },
      { name: 'HIVE_SKILLS_TARGETS', description: 'Optional initial deployment targets: name=user@host, comma-separated.' },
    ].map((entry) => ({ required: false, secret: false, ...entry })),
  };
}
