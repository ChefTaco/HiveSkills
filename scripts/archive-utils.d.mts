export const MAX_ARCHIVE_BYTES: number;
export function readArchive(bytes: Uint8Array): Array<{ name: string; directory: boolean; bytes: Buffer }>;
export function extractArchive(bytes: Uint8Array, destination: string): void;
export function boundedResponse(response: Response, limit: number): Promise<Buffer>;
export type ReleaseSignature = { keyId: string; value: string };
export function releaseSigningMessage(slug: string, version: string, sha256: string): Buffer;
export function parsePublisherKeys(value: string | undefined | null): Map<string, import('node:crypto').KeyObject>;
export function verifyReleaseSignature(keys: Map<string, import('node:crypto').KeyObject>, release: { slug: string; version: string; sha256: string }, signature: unknown): boolean;
