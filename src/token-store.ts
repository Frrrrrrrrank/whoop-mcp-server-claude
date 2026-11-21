import type { TokenPersistence, TokenStatus } from './persistence.js';

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  /** When this token pair was obtained; decides which copy is newer. */
  updated_at?: number;
}

const SAVE_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TokenStore {
  private current: TokenData | null = null;
  private persistence: TokenPersistence | null = null;
  private status: TokenStatus = { state: 'ok' };
  /** Resolves once boot-time hydration has finished; requests wait for it. */
  ready: Promise<void> = Promise.resolve();
  /** Called on state changes worth a human's attention (re-auth needed, saves failing). */
  onAlert: (message: string) => void = () => {};

  setPersistence(p: TokenPersistence | null) {
    this.persistence = p;
  }

  get durable(): boolean {
    return this.persistence !== null;
  }

  /**
   * Adopt the durable copy when it is newer than what this process holds
   * (another instance may have rotated it). Never replaces a newer in-memory
   * token with an older stored one — that is how a failed save would turn
   * into a dead token. Returns true if a token is available afterwards.
   */
  async hydrate(): Promise<boolean> {
    if (!this.persistence) return this.current !== null;
    const data = await this.persistence.load();
    if (data?.refresh_token && (!this.current || (data.updated_at ?? 0) > (this.current.updated_at ?? 0))) {
      this.current = data;
    }
    const status = await this.persistence.loadStatus();
    if (status && (status.last_error_at ?? 0) > (this.status.last_error_at ?? 0)) this.status = status;
    if (this.current && this.status.state === 'reauth_required' && (this.current.updated_at ?? 0) > (this.status.last_error_at ?? 0)) {
      this.status = { ...this.status, state: 'ok' };
    }
    return this.current !== null;
  }

  set(data: { access_token: string; refresh_token: string; expires_in: number }) {
    const now = Date.now();
    this.current = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: now + (data.expires_in - 60) * 1000,
      updated_at: now,
    };
    this.status = { ...this.status, state: 'ok', last_refresh_at: now };
  }

  /**
   * Write the current token to durable storage, retrying. Callers in the
   * refresh / code-exchange paths await this so a rotated refresh token is
   * saved BEFORE we rely on it again. A failure is surfaced, not swallowed.
   */
  async persist(): Promise<boolean> {
    if (!this.persistence || !this.current) return true;
    for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt++) {
      if (await this.persistence.save(this.current)) {
        await this.persistence.saveStatus(this.status);
        return true;
      }
      if (attempt < SAVE_ATTEMPTS) await sleep(500 * 2 ** (attempt - 1));
    }
    this.recordError('degraded', 'Rotated WHOOP token could not be saved to Upstash; it will be lost on the next restart.');
    return false;
  }

  get(): TokenData | null {
    return this.current;
  }

  getStatus(): TokenStatus {
    return this.status;
  }

  isAuthenticated(): boolean {
    return this.current !== null && this.status.state !== 'reauth_required';
  }

  isExpired(): boolean {
    return !this.current || Date.now() >= this.current.expires_at;
  }

  /** WHOOP rejected the refresh token: drop it everywhere and say so. */
  async markReauthRequired(reason: string) {
    this.current = null;
    this.recordError('reauth_required', reason);
    if (this.persistence) {
      await this.persistence.del();
      await this.persistence.saveStatus(this.status);
    }
  }

  recordError(state: TokenStatus['state'], message: string) {
    const changed = this.status.state !== state;
    this.status = { ...this.status, state, last_error: message, last_error_at: Date.now() };
    console.error(`[token] ${state}: ${message}`);
    if (changed && state !== 'ok') this.onAlert(message);
  }

  async lock(owner: string, ttlMs: number): Promise<boolean> {
    return this.persistence ? this.persistence.acquireLock(owner, ttlMs) : true;
  }

  async unlock(owner: string): Promise<void> {
    if (this.persistence) await this.persistence.releaseLock(owner);
  }

  clear() {
    this.current = null;
    if (this.persistence) {
      // best-effort wipe so a cold start doesn't retry a revoked token
      void this.persistence.del();
    }
  }
}
