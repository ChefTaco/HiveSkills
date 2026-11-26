import { addressKey, resolveClientAddress, trustedProxies, type TrustedProxies } from '@hivemagnus/hive-common/rate-limit';

/**
 * Sign-in throttling for PAM accounts. It slows guessing down; it is not a lockout. Configure
 * PAM `faillock` (or the host's equivalent) for the account lockout that PAM itself enforces.
 *
 * - Per account: after a failed attempt the account waits `ACCOUNT_DELAY_MS`.
 * - Per source address: at most `SOURCE_MAX_FAILURES` failed attempts in `SOURCE_WINDOW_MS`,
 *   across every account, so one client cannot cycle through names.
 */
export const ACCOUNT_DELAY_MS = 15_000;
export const SOURCE_WINDOW_MS = 5 * 60_000;
export const SOURCE_MAX_FAILURES = 10;
/**
 * Accounts with a pending delay; beyond this the oldest delay is forgotten. Refusing new accounts
 * instead would let a few sources, each within its own limit, block every sign-in.
 */
export const MAX_ACCOUNTS = 10_000;
/** Tracked sources; beyond this the oldest source is forgotten rather than refusing everyone. */
export const MAX_SOURCES = 10_000;

export type Refusal = {
  reason: 'account' | 'source';
  retryAfterSeconds: number;
  /** True only for the first refusal of this delay or window, so refusals are audited once. */
  first: boolean;
};

type Account = { until: number; refused: boolean };
type Source = { start: number; failures: number; refused: boolean };

export class LoginThrottle {
  private readonly accounts = new Map<string, Account>();
  private readonly sources = new Map<string, Source>();

  constructor(private readonly clock: () => number = Date.now) {}

  private prune(now: number): void {
    for (const [key, value] of this.accounts) if (value.until <= now) this.accounts.delete(key);
    for (const [key, value] of this.sources) if (value.start + SOURCE_WINDOW_MS <= now) this.sources.delete(key);
  }

  /** Undefined when the attempt may reach PAM; otherwise why it may not. */
  refusal(username: string, source: string): Refusal | undefined {
    const now = this.clock();
    this.prune(now);
    const seconds = (until: number) => Math.max(1, Math.ceil((until - now) / 1000));
    const from = this.sources.get(source);
    if (from && from.failures >= SOURCE_MAX_FAILURES) {
      const first = !from.refused; from.refused = true;
      return { reason: 'source', retryAfterSeconds: seconds(from.start + SOURCE_WINDOW_MS), first };
    }
    const account = this.accounts.get(username);
    if (account) {
      const first = !account.refused; account.refused = true;
      return { reason: 'account', retryAfterSeconds: seconds(account.until), first };
    }
    return undefined;
  }

  /** Record a failed PAM attempt; returns the account delay and the source's failures in its window. */
  failed(username: string, source: string): { accountDelaySeconds: number; sourceFailures: number } {
    const now = this.clock();
    // Delays all last ACCOUNT_DELAY_MS, so insertion order is expiry order: re-insert, then drop
    // the soonest to expire when full.
    this.accounts.delete(username);
    if (this.accounts.size >= MAX_ACCOUNTS) this.accounts.delete(this.accounts.keys().next().value!);
    this.accounts.set(username, { until: now + ACCOUNT_DELAY_MS, refused: false });
    let from = this.sources.get(source);
    if (!from) {
      if (this.sources.size >= MAX_SOURCES) this.sources.delete(this.sources.keys().next().value!);
      from = { start: now, failures: 0, refused: false };
      this.sources.set(source, from);
    }
    from.failures++;
    return { accountDelaySeconds: ACCOUNT_DELAY_MS / 1000, sourceFailures: from.failures };
  }

  /** A successful sign-in clears the account's delay; the source keeps its failures. */
  succeeded(username: string): void {
    this.accounts.delete(username);
  }
}

/**
 * Proxies from `HIVE_SKILLS_TRUSTED_PROXIES`: IP addresses, CIDR ranges and the presets `loopback`,
 * `private` and `linklocal`, comma- or space-separated (HiveCommon `trustedProxies()`).
 */
export function parseTrustedProxies(value: string | undefined): TrustedProxies {
  try { return trustedProxies(value); } catch (error) {
    throw new Error(`HIVE_SKILLS_TRUSTED_PROXIES: ${error instanceof Error ? error.message : String(error)}; use IP addresses, CIDR ranges or loopback, private, linklocal`);
  }
}

/**
 * The client address (HiveCommon `resolveClientAddress()`): the socket peer, or, when the peer is a
 * trusted proxy, the right-most `X-Forwarded-For` address that is not itself a trusted proxy. Ports
 * (`192.0.2.1:5678`, `[2001:db8::1]:443`) are stripped. `unknown` when there is no peer.
 */
export function clientAddress(peer: string | undefined, forwardedFor: string | undefined, trusted: TrustedProxies): string {
  return resolveClientAddress({ peer, forwardedFor, trusted }).address;
}

/** The throttle key of a client address: the address for IPv4, its /64 for IPv6 (HiveCommon `addressKey()`). */
export const sourceKey = (address: string): string => addressKey(address);
