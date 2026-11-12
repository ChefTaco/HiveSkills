import { DatabaseSync } from 'node:sqlite';
/**
 * Additive Magnus agent links for deployment targets. Kept in a side table so
 * the released positional deployment_targets writes stay readable and writable.
 */
export function initializeTargetAgentLinks(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS target_agent_links (
    target TEXT PRIMARY KEY REFERENCES deployment_targets(name), magnus_node_id TEXT,
    agent_refs_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS target_agent_links_node ON target_agent_links(magnus_node_id);`);
}
