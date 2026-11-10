import { DatabaseSync } from './sqlite.js';
import { initializeSchema as initializeBaseline } from './migrations/managed-format-1.js';
import { initializeDeploymentJournal } from './migrations/managed-format-2.js';
// The released, checksum-pinned migrations use only these SQL operations.
// Adapt their structural connection boundary without changing migration bytes.
interface SchemaConnection {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: unknown[]): unknown;
    all(...values: unknown[]): unknown[];
    run(...values: unknown[]): unknown;
  };
}
const baseline = initializeBaseline as (db: SchemaConnection) => void;
const deploymentJournal = initializeDeploymentJournal as (db: SchemaConnection) => void;
/** Append additive modules; the published baseline remains immutable. */
export function initializeSchema(db: DatabaseSync): void {
  baseline(db);
  deploymentJournal(db);
}
