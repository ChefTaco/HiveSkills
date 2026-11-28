export function keygen(options: { out: string; keyId: string }): { keyId: string; publicKey: string };
export function signRelease(options: { key: string; keyId: string; slug: string; version: string; archive?: string; sha256?: string }): { keyId: string; signature: string; sha256: string };
export function signRevocations(options: { key: string; keyId: string; list: string | Record<string, unknown>; now?: Date }): { payload: string; signature: { keyId: string; value: string } };
