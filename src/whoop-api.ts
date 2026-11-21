import axios, { AxiosInstance, isAxiosError } from 'axios';
import crypto from 'node:crypto';
import {
  WhoopApiConfig,
  WhoopUserProfile,
  WhoopBodyMeasurements,
  WhoopCycle,
  WhoopCycleCollection,
  WhoopRecovery,
  WhoopRecoveryCollection,
  WhoopSleep,
  WhoopSleepCollection,
  WhoopWorkout,
  WhoopWorkoutCollection,
  PaginationParams,
} from './types.js';
import { TokenData, TokenStore } from './token-store.js';

// Overridable only so tests can point at a local fake; production uses the defaults.
const WHOOP_API_BASE = process.env.WHOOP_API_BASE ?? 'https://api.prod.whoop.com/developer/v2';
const WHOOP_OAUTH_BASE = process.env.WHOOP_OAUTH_BASE ?? 'https://api.prod.whoop.com/oauth/oauth2';
const WHOOP_SCOPES = [
  'read:recovery',
  'read:cycles',
  'read:workout',
  'read:sleep',
  'read:profile',
  'read:body_measurement',
  'offline',
];
const LOCK_TTL_MS = 30_000;
const LOCK_WAIT_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The stored WHOOP grant is gone; only a browser re-authorization fixes it. */
export class AuthRequiredError extends Error {
  constructor(authorizeUrl: string, detail?: string) {
    super(
      `WHOOP authorization expired${detail ? ` (${detail})` : ''}. ` +
        `Open ${authorizeUrl} in a browser to reconnect.`
    );
    this.name = 'AuthRequiredError';
  }
}

export class WhoopApiClient {
  private client: AxiosInstance;
  private inflightRefresh: Promise<TokenData> | null = null;

  constructor(private config: WhoopApiConfig, private tokenStore: TokenStore) {
    this.client = axios.create({
      baseURL: WHOOP_API_BASE,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30_000,
    });

    this.client.interceptors.request.use(async (cfg) => {
      cfg.headers.Authorization = `Bearer ${await this.getValidAccessToken()}`;
      return cfg;
    });
  }

  get authorizeUrl(): string {
    return this.config.redirectUri.replace(/\/callback$/, '/authorize');
  }

  private async getValidAccessToken(): Promise<string> {
    await this.tokenStore.ready;
    // Another instance may have been (re)authorized or rotated since we last looked.
    if (!this.tokenStore.get() || this.tokenStore.isExpired()) await this.tokenStore.hydrate();
    const tok = this.tokenStore.get();
    if (!tok) throw new AuthRequiredError(this.authorizeUrl, this.tokenStore.getStatus().last_error);
    if (!this.tokenStore.isExpired()) return tok.access_token;
    return (await this.refreshShared()).access_token;
  }

  /**
   * WHOOP revokes the whole token chain when one refresh token is used twice,
   * so every concurrent caller in this process shares a single refresh.
   */
  refreshShared(): Promise<TokenData> {
    if (!this.inflightRefresh) {
      this.inflightRefresh = this.refreshUnderLock().finally(() => {
        this.inflightRefresh = null;
      });
    }
    return this.inflightRefresh;
  }

  /** Cross-instance half: hold the Redis lock, then refresh from the newest stored token. */
  private async refreshUnderLock(): Promise<TokenData> {
    const owner = crypto.randomUUID();
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (!(await this.tokenStore.lock(owner, LOCK_TTL_MS))) {
      // Someone else is refreshing; use their result as soon as it lands.
      await sleep(400);
      await this.tokenStore.hydrate();
      const tok = this.tokenStore.get();
      if (tok && !this.tokenStore.isExpired()) return tok;
      if (Date.now() > deadline) throw new Error('Timed out waiting for another instance to refresh the WHOOP token');
    }
    try {
      await this.tokenStore.hydrate();
      const tok = this.tokenStore.get();
      if (!tok) throw new AuthRequiredError(this.authorizeUrl, this.tokenStore.getStatus().last_error);
      if (!this.tokenStore.isExpired()) return tok;
      await this.refreshTokens(tok.refresh_token);
      return this.tokenStore.get()!;
    } finally {
      await this.tokenStore.unlock(owner);
    }
  }

  async refreshTokens(refreshToken: string) {
    const form = new URLSearchParams();
    form.append('grant_type', 'refresh_token');
    form.append('refresh_token', refreshToken);
    form.append('client_id', this.config.clientId);
    form.append('client_secret', this.config.clientSecret);
    form.append('scope', WHOOP_SCOPES.join(' '));

    let resp;
    try {
      resp = await axios.post(`${WHOOP_OAUTH_BASE}/token`, form, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30_000,
      });
    } catch (e) {
      const body = isAxiosError(e) ? (e.response?.data as { error?: string; error_description?: string } | undefined) : undefined;
      if (body?.error === 'invalid_grant') {
        const detail = body.error_description ?? 'refresh token rejected';
        await this.tokenStore.markReauthRequired(`WHOOP rejected the refresh token: ${detail}`);
        throw new AuthRequiredError(this.authorizeUrl, detail);
      }
      this.tokenStore.recordError('degraded', `Token refresh failed: ${(e as Error).message}`);
      throw e;
    }
    this.tokenStore.set(resp.data);
    // WHOOP rotated the refresh token — persist it durably before we move on.
    await this.tokenStore.persist();
    return resp.data as { access_token: string; refresh_token: string; expires_in: number };
  }

  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: WHOOP_SCOPES.join(' '),
      state,
    });
    return `${WHOOP_OAUTH_BASE}/auth?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string) {
    const form = new URLSearchParams();
    form.append('grant_type', 'authorization_code');
    form.append('code', code);
    form.append('client_id', this.config.clientId);
    form.append('client_secret', this.config.clientSecret);
    form.append('redirect_uri', this.config.redirectUri);

    const resp = await axios.post(`${WHOOP_OAUTH_BASE}/token`, form, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    this.tokenStore.set(resp.data);
    // Seed durable storage right after the OAuth code exchange.
    await this.tokenStore.persist();
    return resp.data as { access_token: string; refresh_token: string; expires_in: number };
  }

  // ---- WHOOP v2 endpoints ----
  async getUserProfile(): Promise<WhoopUserProfile> {
    return (await this.client.get('/user/profile/basic')).data;
  }

  async getUserBodyMeasurements(): Promise<WhoopBodyMeasurements> {
    return (await this.client.get('/user/measurement/body')).data;
  }

  async revokeUserAccess(): Promise<void> {
    await this.client.delete('/user/access');
    this.tokenStore.clear();
  }

  async getCycleById(cycleId: number): Promise<WhoopCycle> {
    return (await this.client.get(`/cycle/${cycleId}`)).data;
  }

  async getCycleCollection(params?: PaginationParams): Promise<WhoopCycleCollection> {
    return (await this.client.get('/cycle', { params: this.buildPagination(params) })).data;
  }

  async getSleepForCycle(cycleId: number): Promise<WhoopSleep> {
    return (await this.client.get(`/cycle/${cycleId}/sleep`)).data;
  }

  async getRecoveryCollection(params?: PaginationParams): Promise<WhoopRecoveryCollection> {
    return (await this.client.get('/recovery', { params: this.buildPagination(params) })).data;
  }

  async getRecoveryForCycle(cycleId: number): Promise<WhoopRecovery> {
    return (await this.client.get(`/cycle/${cycleId}/recovery`)).data;
  }

  async getSleepById(sleepId: string): Promise<WhoopSleep> {
    return (await this.client.get(`/activity/sleep/${sleepId}`)).data;
  }

  async getSleepCollection(params?: PaginationParams): Promise<WhoopSleepCollection> {
    return (await this.client.get('/activity/sleep', { params: this.buildPagination(params) })).data;
  }

  async getWorkoutById(workoutId: string): Promise<WhoopWorkout> {
    return (await this.client.get(`/activity/workout/${workoutId}`)).data;
  }

  async getWorkoutCollection(params?: PaginationParams): Promise<WhoopWorkoutCollection> {
    return (await this.client.get('/activity/workout', { params: this.buildPagination(params) })).data;
  }

  private buildPagination(p?: PaginationParams) {
    if (!p) return undefined;
    const out: Record<string, string | number> = {};
    if (p.limit !== undefined) out.limit = p.limit;
    if (p.start) out.start = p.start;
    if (p.end) out.end = p.end;
    if (p.nextToken) out.nextToken = p.nextToken;
    return out;
  }
}
