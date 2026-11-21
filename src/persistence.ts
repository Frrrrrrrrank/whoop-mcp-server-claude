import axios from 'axios';
import type { TokenData } from './token-store.js';

/**
 * Durable token storage so the rotated WHOOP refresh token survives
 * Render free-tier cold starts AND redeploys.
 *
 * WHOOP rotates the refresh token on every refresh and invalidates the
 * old one. A purely in-memory store loses the latest token whenever the
 * process restarts; the WHOOP_REFRESH_TOKEN env var only ever holds the
 * very first (now-dead) token. Persisting every rotation here fixes that.
 *
 * WHOOP's OAuth server also revokes the whole token chain when one refresh
 * token is presented twice, so refreshes must never overlap — not inside one
 * process and not across instances (Render runs old and new side by side
 * during a deploy). The lock below is the cross-instance half of that rule.
 */
export interface TokenStatus {
  state: 'ok' | 'reauth_required' | 'degraded';
  last_refresh_at?: number;
  last_error?: string;
  last_error_at?: number;
}

export interface TokenPersistence {
  load(): Promise<TokenData | null>;
  /** Returns false when the write did not reach durable storage. */
  save(data: TokenData): Promise<boolean>;
  del(): Promise<void>;
  /** SET NX with expiry; true when this caller now holds the lock. */
  acquireLock(owner: string, ttlMs: number): Promise<boolean>;
  /** Deletes the lock only if `owner` still holds it. */
  releaseLock(owner: string): Promise<void>;
  loadStatus(): Promise<TokenStatus | null>;
  saveStatus(status: TokenStatus): Promise<void>;
}

const KEY = 'whoop:token';
const LOCK_KEY = 'whoop:refresh-lock';
const STATUS_KEY = 'whoop:status';
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** Upstash Redis via its HTTP REST API (no TCP, ideal for Render free). */
export class UpstashPersistence implements TokenPersistence {
  constructor(private url: string, private token: string) {}

  private headers() {
    return { Authorization: `Bearer ${this.token}` };
  }

  /** Runs one Redis command through the REST endpoint (JSON array body). */
  private async command(args: (string | number)[]): Promise<unknown> {
    const resp = await axios.post(this.url, args.map(String), {
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    return resp.data?.result;
  }

  async load(): Promise<TokenData | null> {
    try {
      const raw = await this.command(['GET', KEY]);
      if (typeof raw !== 'string' || !raw) return null;
      const parsed = JSON.parse(raw) as TokenData;
      if (!parsed?.refresh_token) return null;
      return parsed;
    } catch (e) {
      console.error('[persistence] Upstash load failed:', (e as Error).message);
      return null;
    }
  }

  async save(data: TokenData): Promise<boolean> {
    try {
      return (await this.command(['SET', KEY, JSON.stringify(data)])) === 'OK';
    } catch (e) {
      console.error('[persistence] Upstash save failed:', (e as Error).message);
      return false;
    }
  }

  async del(): Promise<void> {
    try {
      await this.command(['DEL', KEY]);
    } catch (e) {
      console.error('[persistence] Upstash del failed:', (e as Error).message);
    }
  }

  async acquireLock(owner: string, ttlMs: number): Promise<boolean> {
    try {
      return (await this.command(['SET', LOCK_KEY, owner, 'NX', 'PX', ttlMs])) === 'OK';
    } catch (e) {
      // Without Redis we cannot coordinate; refusing would block every request,
      // so fall back to the in-process single-flight and log loudly.
      console.error('[persistence] Upstash lock failed, refreshing without cross-instance lock:', (e as Error).message);
      return true;
    }
  }

  async releaseLock(owner: string): Promise<void> {
    try {
      await this.command(['EVAL', RELEASE_SCRIPT, 1, LOCK_KEY, owner]);
    } catch (e) {
      console.error('[persistence] Upstash unlock failed (lock expires on its own):', (e as Error).message);
    }
  }

  async loadStatus(): Promise<TokenStatus | null> {
    try {
      const raw = await this.command(['GET', STATUS_KEY]);
      return typeof raw === 'string' && raw ? (JSON.parse(raw) as TokenStatus) : null;
    } catch (e) {
      console.error('[persistence] Upstash status load failed:', (e as Error).message);
      return null;
    }
  }

  async saveStatus(status: TokenStatus): Promise<void> {
    try {
      await this.command(['SET', STATUS_KEY, JSON.stringify(status)]);
    } catch (e) {
      console.error('[persistence] Upstash status save failed:', (e as Error).message);
    }
  }
}

/**
 * Builds a persistence backend from env vars. Returns null (with a loud
 * warning) if Upstash is not configured, so the server still runs — it
 * just won't survive cold starts, exactly like the old behaviour.
 */
export function createPersistence(): TokenPersistence | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.warn(
      '[persistence] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — ' +
        'WHOOP token will NOT survive cold starts/redeploys. Configure Upstash to fix this.'
    );
    return null;
  }
  console.log('[persistence] Upstash durable token store enabled.');
  return new UpstashPersistence(url.replace(/\/+$/, ''), token);
}
