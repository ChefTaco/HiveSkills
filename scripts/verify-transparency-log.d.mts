import type { LogHead, LogRow } from './transparency-log.mjs';
export function fetchTransparencyLog(options: { registry: string; target?: string | undefined; token?: string | undefined; bearer?: string | undefined; fetchImpl?: typeof fetch }): Promise<{ head: LogHead; entries: LogRow[] }>;
export function main(argv: string[], env?: Record<string, string | undefined>, fetchImpl?: typeof fetch): Promise<ReturnType<typeof import('./transparency-log.mjs').verifyTransparencyLog>>;
