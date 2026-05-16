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
 */
export interface TokenPersistence {
  load(): Promise<TokenData | null>;
  save(data: TokenData): Promise<void>;
  del(): Promise<void>;
}

const KEY = 'whoop:token';

/** Upstash Redis via its HTTP REST API (no TCP, ideal for Render free). */
export class UpstashPersistence implements TokenPersistence {
  constructor(private url: string, private token: string) {}

  private headers() {
    return { Authorization: `Bearer ${this.token}` };
  }

  async load(): Promise<TokenData | null> {
    try {
      const resp = await axios.get(`${this.url}/get/${KEY}`, {
        headers: this.headers(),
        timeout: 10000,
      });
      const raw = resp.data?.result;
      if (!raw) return null;
      const parsed = JSON.parse(raw) as TokenData;
      if (!parsed?.refresh_token) return null;
      return parsed;
    } catch (e) {
      console.error('[persistence] Upstash load failed:', (e as Error).message);
      return null;
    }
  }

  async save(data: TokenData): Promise<void> {
    try {
      // Upstash REST: POST {url}/set/{key} with the raw request body as value.
      await axios.post(`${this.url}/set/${KEY}`, JSON.stringify(data), {
        headers: { ...this.headers(), 'Content-Type': 'text/plain' },
        timeout: 10000,
      });
    } catch (e) {
      console.error('[persistence] Upstash save failed:', (e as Error).message);
    }
  }

  async del(): Promise<void> {
    try {
      await axios.post(`${this.url}/del/${KEY}`, null, {
        headers: this.headers(),
        timeout: 10000,
      });
    } catch (e) {
      console.error('[persistence] Upstash del failed:', (e as Error).message);
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
