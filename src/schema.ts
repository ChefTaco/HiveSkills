import { DatabaseSync } from 'node:sqlite';
import { initializeSchema as initializeBaseline } from './migrations/managed-format-1.js';
import { initializeDeploymentJournal } from './migrations/managed-format-2.js';
/** Append additive modules; the published baseline remains immutable. */
export function initializeSchema(db: DatabaseSync): void {
  initializeBaseline(db);
  initializeDeploymentJournal(db);
}
