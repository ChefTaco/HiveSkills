import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from './sqlite.js';
import { packageRoot } from './paths.js';
import { initializeSchema } from './schema.js';
import {
  guardedMigration,
  hash,
  home,
  metadata,
  migrationFlags,
  migrationReview,
  schemaCommit,
  schemaPlan,
  storeSpec,
  type Release,
} from './release/runtime.js';

/**
 * HiveSkills' storage-format history, which `migrate` checks the data directory against. It used to
 * come from a Hive 1.2.2 bundle manifest frozen in package.json (naming retired components), which
 * made health and `/admin/updates` report release 1.2.2. The skills entries are unchanged, so the
 * schema checksum (and with it every installation's recorded state) stays the same. Append entries
 * here; never edit or reorder them.
 */
export const SKILLS_MIGRATIONS: Release['migrations'] = [
  {
    component: 'skills',
    id: 'managed-format-1',
    checksum: 'b73f6f050c25fd3a2a31623d703aebc14d7997598f60e35d4d90f0f99a9a4cfe',
    impact: 'fast',
    readableBy: '^1.1.0',
    note: 'Adopt existing compatible state and record its format; no destructive conversion.',
  },
  {
    component: 'skills',
    id: 'managed-format-2',
    checksum: 'a9803de4fb36b043e8ab0f7e8fe4f09f652ffa7c9f1d8eed3674a6e4756544f1',
    impact: 'fast',
    readableBy: '^1.2.2',
    note: 'Add durable exact-publication deployment approvals and Magnus receipt references without altering legacy jobs.',
  },
  {
    component: 'skills',
    id: 'managed-format-3',
    checksum: 'f0e4ce285573b35b41865eb979dc2959b345342b3450604d7e43d68d969c792f',
    impact: 'fast',
    readableBy: '^1.1.0',
    note: 'Add optional Magnus node and agent reference bindings for deployment targets in a side table; legacy target rows and older binaries are unaffected.',
  },
  {
    component: 'skills',
    id: 'managed-format-4',
    checksum: '68c0c42def3a6c23d31833b32e3a9119644d6f265922fb90b9076a9be8e1fd44',
    impact: 'fast',
    readableBy: '^1.1.0',
    note: 'Add advisory deprecation and yank notices for immutable releases in a side table; release rows and older binaries are unaffected.',
  },
];
/** The oldest HiveSkills whose code reads data written by this one. */
export const SKILLS_DATA_COMPATIBILITY = '^1.1.0';

/** This package's own release record for the migration engine, versioned with the package. */
export function skillsRelease(root = packageRoot): Release {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string; engines?: { node?: string } };
  return {
    schema: 1,
    version: pkg.version,
    engineProtocol: 1,
    engines: { node: pkg.engines?.node ?? '*' },
    components: { '@hivemagnus/hive-skills': pkg.version },
    optionalComponents: [],
    testedSdks: {},
    minUpgradeFrom: {},
    requiredIntermediates: [],
    newRequiredEnv: [],
    newOptionalEnv: [],
    removedEnv: [],
    migrations: SKILLS_MIGRATIONS,
    wireCompatibility: { skills: '^1.0.0' },
    dataCompatibility: { skills: SKILLS_DATA_COMPATIBILITY },
    summary: 'HiveSkills storage format',
    notesUrl: 'https://github.com/ChefTaco/HiveSkills/releases',
    breaking: false,
  };
}

export async function skillsMigration(args: readonly string[], automatic = false): Promise<void> {
  const flags = migrationFlags(args);
  const data = resolve(process.env.HIVE_SKILLS_DATA_DIR || './data');
  const file = join(data, '.hive-skills-schema.json');
  const database = join(data, 'registry.sqlite');
  const release = skillsRelease();
  const checksum = hash(
    JSON.stringify(
      release.migrations.filter((m) => m.component === 'skills').map((m) => [m.id, m.checksum]),
    ),
  );
  const plan = () => {
    const state = schemaPlan(file, checksum, metadata(packageRoot).version);
    if (existsSync(file) && !existsSync(database))
      throw new Error('Existing Skills database is missing; restore it before starting');
    if (!existsSync(database)) return { ...state, dataChanged: true };
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const columns = new Set(
        db
          .prepare('PRAGMA table_info(releases)')
          .all()
          .map((c) => c.name),
      );
      return {
        ...state,
        dataChanged:
          !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='deployment_authorizations'").get() ||
          !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='target_agent_links'").get() ||
          !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='release_advisories'").get() ||
          !columns.has('min_hermes_version') ||
          !columns.has('max_hermes_version') ||
          !db.prepare("SELECT id FROM registry_migrations WHERE id='release-channels'").get(),
      };
    } finally {
      db.close();
    }
  };
  if (flags.plan) {
    console.log(JSON.stringify({ ...plan(), ...migrationReview(release, 'skills') }));
    return;
  }
  await guardedMigration({
    service: 'skills',
    spec: storeSpec('skills', process.env, home()),
    lock: join(data, 'migration.lock'),
    pending: () => plan().pending.length > 0,
    automatic,
    release,
    ...(flags.backupDir ? { backupDir: flags.backupDir } : {}),
    ...(flags.confirmPlan ? { confirmPlan: flags.confirmPlan } : {}),
    apply: async () => {
      const db = new DatabaseSync(database);
      try {
        initializeSchema(db);
      } finally {
        db.close();
      }
      schemaCommit(file, checksum, release.version, release.dataCompatibility.skills!);
    },
  });
}
