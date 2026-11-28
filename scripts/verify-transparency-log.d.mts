import type { LogHead, LogRow } from './transparency-log.mjs';
export const DEFAULT_PAGE_SIZE: number;
export function fetchTransparencyLog(options: { registry: string; target?: string | undefined; token?: string | undefined; bearer?: string | undefined; fetchImpl?: typeof fetch; pageSize?: number }): Promise<{ head: LogHead; entries: LogRow[]; revocationPayloads: Record<string, string> }>;
export function main(argv: string[], env?: Record<string, string | undefined>, fetchImpl?: typeof fetch): Promise<ReturnType<typeof import('./transparency-log.mjs').verifyTransparencyLog>>;
