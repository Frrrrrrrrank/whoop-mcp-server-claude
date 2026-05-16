import type { TokenPersistence } from './persistence.js';

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export class TokenStore {
  private current: TokenData | null = null;
  private persistence: TokenPersistence | null = null;

  setPersistence(p: TokenPersistence | null) {
    this.persistence = p;
  }

  /**
   * Hydrate the in-memory token from durable storage on boot.
   * Returns true if a usable token was loaded.
   */
  async hydrate(): Promise<boolean> {
    if (!this.persistence) return false;
    const data = await this.persistence.load();
    if (data?.refresh_token) {
      this.current = data;
      return true;
    }
    return false;
  }

  set(data: { access_token: string; refresh_token: string; expires_in: number }) {
    this.current = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in - 60) * 1000,
    };
  }

  /**
   * Write the current token to durable storage. Callers in the refresh /
   * code-exchange paths await this so a rotated refresh token is saved
   * BEFORE we rely on it again.
   */
  async persist(): Promise<void> {
    if (this.persistence && this.current) {
      await this.persistence.save(this.current);
    }
  }

  get(): TokenData | null {
    return this.current;
  }

  isExpired(): boolean {
    return !this.current || Date.now() >= this.current.expires_at;
  }

  clear() {
    this.current = null;
    if (this.persistence) {
      // best-effort wipe so a cold start doesn't retry a revoked token
      void this.persistence.del();
    }
  }
}
