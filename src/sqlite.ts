import { DatabaseSync as NativeDatabase } from '@photostructure/sqlite';

/** Execute the bundled engine check; image and npm feeds omit embedded SQLite. */
export class DatabaseSync extends NativeDatabase {
  constructor(...args: ConstructorParameters<typeof NativeDatabase>) {
    super(...args);
    try {
      const row: unknown = this.prepare('SELECT sqlite_version() AS version').get();
      const version = row !== null && typeof row === 'object' && 'version' in row ? row.version : undefined;
      const match = typeof version === 'string' ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version) : null;
      if (!match || !(Number(match[1]) > 3 || (Number(match[1]) === 3 && (Number(match[2]) > 54 || (Number(match[2]) === 54 && Number(match[3]) >= 1))))) {
        throw new Error('Embedded SQLite 3.54.1 or later is required');
      }
    } catch (error) { this.close(); throw error; }
  }
}
