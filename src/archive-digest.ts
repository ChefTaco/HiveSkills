import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

/** Archives whose digest is remembered; the least recently used one is forgotten first. */
export const ARCHIVE_DIGEST_CACHE_ENTRIES = 1024;

type Known = { size: number; mtimeMs: number; ino: number; sha256: string };
const known = new Map<string, Known>();
const pending = new Map<string, Promise<string>>();

const identity = (path: string, stat: Stats): string => `${path}\0${stat.size}\0${stat.mtimeMs}\0${stat.ino}`;

async function hash(handle: FileHandle): Promise<string> {
  const digest = createHash('sha256');
  // A read stream yields between chunks, so hashing a large archive does not stall other requests.
  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) digest.update(chunk as Buffer);
  return digest.digest('hex');
}

/**
 * The SHA-256 of the open archive. A file with the same path, size, mtime and inode as one
 * already hashed is not read again; concurrent requests for the same file share one hash.
 */
export async function archiveDigest(path: string, handle: FileHandle, stat: Stats): Promise<string> {
  const cached = known.get(path);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ino === stat.ino) {
    known.delete(path); known.set(path, cached);
    return cached.sha256;
  }
  const key = identity(path, stat);
  let running = pending.get(key);
  if (!running) {
    running = hash(handle).finally(() => pending.delete(key));
    pending.set(key, running);
  }
  const sha256 = await running;
  known.delete(path);
  known.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, sha256 });
  while (known.size > ARCHIVE_DIGEST_CACHE_ENTRIES) known.delete(known.keys().next().value!);
  return sha256;
}

/** Forget every remembered digest (tests). */
export const clearArchiveDigests = (): void => { known.clear(); };
