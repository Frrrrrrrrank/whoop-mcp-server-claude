import express, { Request, Response } from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WhoopApiClient } from './whoop-api.js';
import { TokenStore } from './token-store.js';
import { createPersistence } from './persistence.js';
import { buildMcpServer } from './mcp-server.js';
import { WhoopApiConfig } from './types.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '');

const config: WhoopApiConfig = {
  clientId: requireEnv('WHOOP_CLIENT_ID'),
  clientSecret: requireEnv('WHOOP_CLIENT_SECRET'),
  redirectUri: `${PUBLIC_URL}/callback`,
};

const tokenStore = new TokenStore();
tokenStore.setPersistence(createPersistence());
const whoopClient = new WhoopApiClient(config, tokenStore);

// Boot order matters. WHOOP rotates the refresh token on every refresh,
// so the durable store always holds the *latest* valid token while the
// WHOOP_REFRESH_TOKEN env var only ever holds the original (single-use,
// now-dead) one. Therefore: durable store first, env var only as a
// first-run seed.
(async () => {
  try {
    if (await tokenStore.hydrate()) {
      console.log('Loaded WHOOP token from durable store (survives cold starts).');
      return;
    }
    if (process.env.WHOOP_REFRESH_TOKEN) {
      await whoopClient.refreshTokens(process.env.WHOOP_REFRESH_TOKEN);
      console.log(
        'Bootstrapped from WHOOP_REFRESH_TOKEN env var and persisted the ' +
          'rotated token to the durable store.'
      );
      return;
    }
    console.warn('No durable token and no WHOOP_REFRESH_TOKEN. Visit /authorize to connect.');
  } catch (e) {
    console.error('Token bootstrap failed:', (e as Error).message);
    console.error('Re-authorize at /authorize to recover.');
  }
})();

const oauthStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;
function newState(): string {
  const s = crypto.randomBytes(16).toString('hex');
  oauthStates.set(s, Date.now() + STATE_TTL_MS);
  // GC old states
  for (const [k, v] of oauthStates) if (v < Date.now()) oauthStates.delete(k);
  return s;
}
function consumeState(s: string): boolean {
  const exp = oauthStates.get(s);
  if (!exp) return false;
  oauthStates.delete(s);
  return exp >= Date.now();
}

const app = express();
app.use(cors({ origin: '*', exposedHeaders: ['Mcp-Session-Id'] }));
app.use(express.json({ limit: '4mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    authenticated: !!tokenStore.get(),
    redirectUri: config.redirectUri,
  });
});

app.get('/', (_req, res) => {
  const authed = !!tokenStore.get();
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>WHOOP MCP Server</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 640px; margin: 60px auto; padding: 24px; color: #1a1a1a; }
  .card { background: #f6f7f9; padding: 28px; border-radius: 12px; }
  .btn { display: inline-block; background: #0a84ff; color: white; padding: 12px 22px; border-radius: 8px; text-decoration: none; font-weight: 600; }
  .ok { color: #1a7a3a; }
  code { background: #ececec; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  .muted { color: #777; font-size: 13px; }
</style></head>
<body><div class="card">
  <h1>WHOOP MCP Server</h1>
  <p>Remote MCP server exposing the WHOOP v2 API to MCP clients (Claude.ai, Claude Desktop, etc.).</p>
  <p>Status: ${authed ? '<span class="ok">authenticated</span>' : '<b>not authenticated</b>'}</p>
  <p><a class="btn" href="/authorize">${authed ? 'Re-connect' : 'Connect'} WHOOP</a></p>
  <hr>
  <p class="muted"><b>MCP endpoint</b>: <code>${PUBLIC_URL}/mcp</code></p>
  <p class="muted"><b>OAuth redirect URI</b> (configure in WHOOP developer portal): <code>${config.redirectUri}</code></p>
</div></body></html>`);
});

app.get('/authorize', (_req, res) => {
  const state = newState();
  res.redirect(whoopClient.getAuthorizationUrl(state));
});

app.get('/callback', async (req, res) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const err = req.query.error as string | undefined;

  if (err) {
    res.status(400).type('html').send(`<h1>WHOOP OAuth error</h1><p>${err}</p>`);
    return;
  }
  if (!code || !state || !consumeState(state)) {
    res.status(400).type('html').send('<h1>Invalid OAuth callback</h1><p>Missing/expired code or state.</p>');
    return;
  }

  try {
    const tok = await whoopClient.exchangeCodeForToken(code);
    res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Connected</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 720px; margin: 60px auto; padding: 24px; }
  .card { background: #f6f7f9; padding: 28px; border-radius: 12px; }
  .ok { color: #1a7a3a; }
  code { background: #ececec; padding: 6px 10px; border-radius: 4px; font-family: ui-monospace, monospace; word-break: break-all; display: block; margin: 8px 0; font-size: 12px; }
  .warn { background: #fff7e6; border-left: 4px solid #f0a500; padding: 12px 14px; margin: 16px 0; }
</style></head>
<body><div class="card">
  <h1 class="ok">✅ WHOOP connected</h1>
  <p>The MCP server now has a valid WHOOP token. You can close this tab and use MCP tools in Claude.</p>
  ${
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
      ? `<div class="warn" style="background:#e9f7ef;border-left-color:#1a7a3a">
    <p><b>Durable storage is active.</b> This token (and every rotation after it)
    is saved to Upstash, so it survives Render cold starts and redeploys
    automatically. You do <b>not</b> need to copy anything or re-authorize.</p>
  </div>`
      : `<div class="warn">
    <p><b>⚠ Durable storage is NOT configured.</b> Render free Web Service sleeps
    after 15 min and WHOOP rotates the refresh token on every refresh, so this
    token will die on the next cold start. Set <code>UPSTASH_REDIS_REST_URL</code>
    and <code>UPSTASH_REDIS_REST_TOKEN</code> env vars (free Upstash Redis) to fix
    this permanently. Until then, the single-use fallback token is:</p>
    <code>${tok.refresh_token}</code>
  </div>`
  }
  <p>Token expires in ${tok.expires_in} seconds; the server refreshes it automatically.</p>
</div></body></html>`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).type('html').send(`<h1>Token exchange failed</h1><pre>${msg}</pre>`);
  }
});

// MCP endpoint (Streamable HTTP transport, stateless)
const handleMcp = async (req: Request, res: Response) => {
  try {
    const server = buildMcpServer(whoopClient);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e: unknown) {
    console.error('MCP handler error:', e);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
};

app.post('/mcp', handleMcp);
app.get('/mcp', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' },
    id: null,
  });
});

app.listen(PORT, () => {
  console.log(`WHOOP MCP server listening on :${PORT}`);
  console.log(`Public URL: ${PUBLIC_URL}`);
  console.log(`OAuth redirect URI: ${config.redirectUri}`);
  console.log(`MCP endpoint: ${PUBLIC_URL}/mcp`);
});
