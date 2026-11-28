export const GENESIS_HASH: string;
export const LOG_KINDS: readonly ['release.published', 'release.signed', 'revocations.published'];
export type LogKind = 'release.published' | 'release.signed' | 'revocations.published';
export type LogRow = { index: number; entry: string; hash: string; keyId: string; signature: string };
export type LogHead = { size: number; headHash: string; logKey: { keyId: string; publicKey: string }; signature: string };
export function entryHash(entry: string): string;
export function entrySigningMessage(index: number, hash: string): Buffer;
export function headSigningMessage(size: number, headHash: string): Buffer;
export function logKeyId(publicKey: string): string;
export function ed25519PublicKey(publicKey: string): import('node:crypto').KeyObject;
export function buildEntry(fields: { index: number; previousHash: string; kind: LogKind; recordedAt: string; subject: Record<string, unknown> }): string;
export function verifyTransparencyLog(options: {
  entries: LogRow[];
  head: LogHead;
  logKeys?: Map<string, import('node:crypto').KeyObject> | string | undefined;
  publisherKeys?: Map<string, import('node:crypto').KeyObject> | undefined;
  revocationKeys?: Map<string, import('node:crypto').KeyObject> | undefined;
  knownHead?: { size: number; headHash: string } | undefined;
}): { size: number; headHash: string; releases: number; releaseSignatures: number; revocationLists: number; revocationSequence: number; warnings: string[] };
