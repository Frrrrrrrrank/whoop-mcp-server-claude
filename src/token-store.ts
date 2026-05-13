export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export class TokenStore {
  private current: TokenData | null = null;

  set(data: { access_token: string; refresh_token: string; expires_in: number }) {
    this.current = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in - 60) * 1000,
    };
  }

  get(): TokenData | null {
    return this.current;
  }

  isExpired(): boolean {
    return !this.current || Date.now() >= this.current.expires_at;
  }

  clear() {
    this.current = null;
  }
}
