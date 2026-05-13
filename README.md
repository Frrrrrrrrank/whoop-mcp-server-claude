# WHOOP Remote MCP Server

Remote Model Context Protocol (MCP) server for the WHOOP v2 API. Exposes WHOOP user, cycle, recovery, sleep, and workout data over **Streamable HTTP transport** so MCP clients like **claude.ai Custom Connectors** can connect to it remotely.

Forked from [nissand/whoop-mcp-server-claude](https://github.com/nissand/whoop-mcp-server-claude) and rewritten for remote deployment.

## What changed vs. upstream

- Transport: `stdio` → `StreamableHTTPServerTransport` (MCP SDK 1.x)
- OAuth: chat-driven copy-paste flow → browser flow at `/authorize` → `/callback`
- Token storage: per-process file → in-memory `TokenStore` with automatic refresh
- Cold-start survival: optional `WHOOP_REFRESH_TOKEN` env var bootstraps token on boot
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
| `WHOOP_REFRESH_TOKEN` | no | Pre-seeds token on boot to survive cold starts |

The OAuth redirect URI is always `${PUBLIC_URL}/callback`. Register that exact value in the WHOOP developer portal.

## Deploy to Render (free tier)

1. Push this repo (or your fork) to GitHub.
2. In Render dashboard: **New → Web Service → Connect repo**. Render detects `render.yaml` and offers a Blueprint deploy.
3. Set env vars `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `PUBLIC_URL`. (Once first deploy completes, copy the `.onrender.com` URL into `PUBLIC_URL` and redeploy.)
4. Update the redirect URI in the WHOOP developer portal to `https://<your-service>.onrender.com/callback`.
5. Visit the service URL, click **Connect WHOOP**, complete OAuth. Optionally copy the displayed refresh token into a `WHOOP_REFRESH_TOKEN` env var and redeploy so the server survives cold starts.

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

The server is **single-tenant**: one WHOOP token is held in memory and used for all MCP requests. The MCP endpoint itself is unauthenticated — the secrecy of the `.onrender.com` URL is the only access control. Acceptable for a personal connector; do not share the URL.

To make it multi-tenant or production-grade, swap the in-memory `TokenStore` for a per-session-token store keyed by either:
- An MCP-side bearer token (configure in Claude as Authorization header), or
- An OAuth 2.1 / RFC 8414 / DCR implementation so claude.ai does proper user auth

## License

MIT (inherited from upstream).
