# WHOOP Remote MCP Server

Remote Model Context Protocol (MCP) server for the WHOOP v2 API. Exposes WHOOP user, cycle, recovery, sleep, and workout data over **Streamable HTTP transport** so MCP clients like **claude.ai Custom Connectors** can connect to it remotely.

Forked from [nissand/whoop-mcp-server-claude](https://github.com/nissand/whoop-mcp-server-claude) and rewritten for remote deployment.

## What changed vs. upstream

- Transport: `stdio` → `StreamableHTTPServerTransport` (MCP SDK 1.x)
- OAuth: chat-driven copy-paste flow → browser flow at `/authorize` → `/callback`
- Token storage: per-process file → in-memory `TokenStore` with automatic refresh
- Cold-start survival: durable token store (Upstash Redis REST) persists every
  refresh-token rotation; `WHOOP_REFRESH_TOKEN` env var is now only a first-run seed
- Removed: `auth-app.js`, `start-mcp-server.js`, `check-redirect-uri.js`, stdio entry points

## Endpoints

| Path | Purpose |
|---|---|
| `GET /` | Landing page with "Connect WHOOP" link |
| `GET /authorize` | 302 redirect to WHOOP OAuth (with CSRF state) |
| `GET /callback` | WHOOP redirects here with `code`; exchanges for tokens |
| `POST /mcp` | MCP Streamable HTTP endpoint |
| `GET /health` | Health check (used by Render) |

## Environment variables

| Name | Required | Description |
|---|---|---|
| `WHOOP_CLIENT_ID` | yes | From WHOOP developer portal |
| `WHOOP_CLIENT_SECRET` | yes | From WHOOP developer portal |
| `PUBLIC_URL` | yes | e.g. `https://your-app.onrender.com` (no trailing slash) |
| `PORT` | no | Default 3000; Render sets automatically |
| `WHOOP_REFRESH_TOKEN` | no | First-run seed only (single-use; WHOOP rotates it) |
| `UPSTASH_REDIS_REST_URL` | recommended | Durable token store; from upstash.com REST API panel |
| `UPSTASH_REDIS_REST_TOKEN` | recommended | Paired auth token for the Upstash REST API |
| `ALERT_WEBHOOK_URL` | no | Webhook for re-auth / save-failure alerts (Feishu bot format) |

The OAuth redirect URI is always `${PUBLIC_URL}/callback`. Register that exact value in the WHOOP developer portal.

### Why durable storage is required on free tiers

WHOOP **rotates the refresh token on every refresh** and immediately invalidates
the previous one. A purely in-memory store loses the latest token whenever the
process restarts (Render free Web Services sleep after 15 min idle and restart on
every deploy). The `WHOOP_REFRESH_TOKEN` env var only ever holds the *original*
token, which WHOOP kills after the first refresh — so without durable storage you
get `invalid_grant` ("authorization expired") on the next cold start.

With `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` set, every rotation is
written to Upstash and reloaded on boot, so the server self-heals across cold
starts and redeploys with no manual re-authorization. Setup: create a free
database at [upstash.com](https://upstash.com) → open it → **REST API** panel →
copy the `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` values into
Render env vars.

### Refreshes never overlap

WHOOP's OAuth server revokes the whole token chain when a refresh token is
presented twice. Several clients hitting the server right after the access
token expires (claude.ai, scripts, a poller), or the old and new instance
during a Render deploy, used to do exactly that and killed the grant roughly
weekly. Now:

- one refresh per process at a time (concurrent requests share it);
- a Redis lock (`whoop:refresh-lock`, `SET NX PX`) so only one instance refreshes;
- before refreshing, the newest stored token is reloaded, and an older stored
  copy never replaces a newer in-memory one;
- saves to Upstash are retried; if they keep failing, the state becomes `degraded`.

When WHOOP rejects the refresh token (`invalid_grant`), the token is dropped,
the state becomes `reauth_required`, tool errors say where to reconnect, and an
optional webhook fires.

### `/health`

Always HTTP 200 (Render's health check uses it). Fields:
`authenticated` (a token is held and WHOOP has not rejected it), `state`
(`ok` / `degraded` / `reauth_required`), `last_refresh_at`, `last_error`,
`durable`, `alerts`. `/health?deep=1` also makes one real WHOOP call and adds
`whoop_call_ok`.

### Alerts (optional)

Set `ALERT_WEBHOOK_URL` to a Feishu custom-bot webhook (or any endpoint that
accepts `{"text": ...}`) to be told when re-authorization is needed or saves fail.

## Deploy to Render (free tier)

1. Push this repo (or your fork) to GitHub.
2. In Render dashboard: **New → Web Service → Connect repo**. Render detects `render.yaml` and offers a Blueprint deploy.
3. Set env vars `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `PUBLIC_URL`. (Once first deploy completes, copy the `.onrender.com` URL into `PUBLIC_URL` and redeploy.)
4. Create a free Redis at [upstash.com](https://upstash.com), open its **REST API** panel, and set `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` env vars in Render. (Strongly recommended — without this the token dies on the next cold start.)
5. Update the redirect URI in the WHOOP developer portal to `https://<your-service>.onrender.com/callback`.
6. Visit the service URL, click **Connect WHOOP**, complete OAuth once. With Upstash configured the token is now persisted and rotated automatically — no copy-paste, no redeploy, no re-authorization needed afterwards.

## Connect from claude.ai

1. claude.ai → **Settings → Connectors → Add Custom Connector**
2. Server URL: `https://<your-service>.onrender.com/mcp`
3. Save. Tools should appear after a refresh.

## Local development

```bash
npm install
cp env.example .env  # fill in CLIENT_ID, CLIENT_SECRET; set PUBLIC_URL=http://localhost:3000
npm run dev          # starts on :3000
# Register http://localhost:3000/callback in WHOOP portal for local OAuth testing
```

## Tools

| Tool | Description |
|---|---|
| `whoop_get_user_profile` | Basic profile (name, email) |
| `whoop_get_user_body_measurements` | Height, weight, max HR |
| `whoop_get_cycle_collection` | Paginated cycles |
| `whoop_get_cycle_by_id` | One cycle |
| `whoop_get_sleep_for_cycle` | Sleep for a cycle |
| `whoop_get_recovery_collection` | Paginated recovery |
| `whoop_get_recovery_for_cycle` | Recovery for a cycle |
| `whoop_get_sleep_collection` | Paginated sleep |
| `whoop_get_sleep_by_id` | One sleep |
| `whoop_get_workout_collection` | Paginated workouts |
| `whoop_get_workout_by_id` | One workout |
| `whoop_revoke_user_access` | Clear server token |

OAuth happens at `/authorize`; there is no MCP tool that takes raw codes/tokens (those were the stdio-era workaround).

## Architecture notes

The server is **single-tenant**: one WHOOP token is held in memory (backed by the
Upstash durable store) and used for all MCP requests. The MCP endpoint itself is
unauthenticated — the secrecy of the `.onrender.com` URL is the only access
control. Acceptable for a personal connector; do not share the URL.

To make it multi-tenant or production-grade, swap the in-memory `TokenStore` for a per-session-token store keyed by either:
- An MCP-side bearer token (configure in Claude as Authorization header), or
- An OAuth 2.1 / RFC 8414 / DCR implementation so claude.ai does proper user auth

## License

MIT (inherited from upstream).
