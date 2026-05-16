import axios, { AxiosInstance } from 'axios';
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
import { TokenStore } from './token-store.js';

const WHOOP_API_BASE = 'https://api.prod.whoop.com/developer/v2';
const WHOOP_OAUTH_BASE = 'https://api.prod.whoop.com/oauth/oauth2';
const WHOOP_SCOPES = [
  'read:recovery',
  'read:cycles',
  'read:workout',
  'read:sleep',
  'read:profile',
  'read:body_measurement',
  'offline',
];

export class WhoopApiClient {
  private client: AxiosInstance;

  constructor(private config: WhoopApiConfig, private tokenStore: TokenStore) {
    this.client = axios.create({
      baseURL: WHOOP_API_BASE,
      headers: { 'Content-Type': 'application/json' },
    });

    this.client.interceptors.request.use(async (cfg) => {
      const token = await this.getValidAccessToken();
      if (token) cfg.headers.Authorization = `Bearer ${token}`;
      return cfg;
    });
  }

  private async getValidAccessToken(): Promise<string | null> {
    const tok = this.tokenStore.get();
    if (!tok) return null;
    if (!this.tokenStore.isExpired()) return tok.access_token;
    const refreshed = await this.refreshTokens(tok.refresh_token);
    return refreshed.access_token;
  }

  async refreshTokens(refreshToken: string) {
    const form = new URLSearchParams();
    form.append('grant_type', 'refresh_token');
    form.append('refresh_token', refreshToken);
    form.append('client_id', this.config.clientId);
    form.append('client_secret', this.config.clientSecret);
    form.append('scope', WHOOP_SCOPES.join(' '));

    const resp = await axios.post(`${WHOOP_OAUTH_BASE}/token`, form, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
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
