/**
 * Token refresh under concurrency, against local fakes:
 *  - a WHOOP OAuth server that, like WHOOP's, rotates the refresh token on
 *    every use and revokes the whole chain when a used token is presented again;
 *  - an Upstash REST endpoint (GET / SET [NX PX] / DEL / EVAL compare-and-delete).
 * Run: npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

type Chain = { refresh: string; access: string; used: Set<string>; alive: boolean };
const whoop = { chain: null as Chain | null, refreshCalls: 0, n: 0, expiresIn: 61, delayMs: 120 };
const redis = { data: new Map<string, { v: string; exp?: number }>(), failTokenSets: 0, tokenSets: 0 };

function newChain(): Chain {
  whoop.n++;
  return { refresh: `rt-${whoop.n}`, access: `at-${whoop.n}`, used: new Set(), alive: true };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

const whoopServer = http.createServer(async (req, res) => {
  const body = await readBody(req);
  if (req.url === '/oauth/token') {
    whoop.refreshCalls++;
    const form = new URLSearchParams(body);
    const rt = form.get('refresh_token')!;
    await new Promise((r) => setTimeout(r, whoop.delayMs));
    const c = whoop.chain;
    if (!c || !c.alive || c.used.has(rt) || rt !== c.refresh) {
      if (c && c.used.has(rt)) c.alive = false; // reuse detected: revoke everything
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token reused or revoked' }));
      return;
    }
    c.used.add(rt);
    whoop.n++;
    c.refresh = `rt-${whoop.n}`;
    c.access = `at-${whoop.n}`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: c.access, refresh_token: c.refresh, expires_in: whoop.expiresIn }));
    return;
  }
  if (req.url?.startsWith('/api/user/profile/basic')) {
    const ok = whoop.chain?.alive && req.headers.authorization === `Bearer ${whoop.chain.access}`;
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { user_id: 1 } : { error: 'unauthorized' }));
    return;
  }
  res.writeHead(404).end();
});

const redisServer = http.createServer(async (req, res) => {
  const cmd = JSON.parse(await readBody(req)) as string[];
  const now = Date.now();
  const get = (k: string) => {
    const e = redis.data.get(k);
    if (e?.exp && e.exp < now) redis.data.delete(k);
    return redis.data.get(k)?.v ?? null;
  };
  let result: unknown = null;
  const [op, key] = [cmd[0].toUpperCase(), cmd[1]];
  if (op === 'GET') result = get(key);
  else if (op === 'SET') {
    if (key === 'whoop:token') {
      redis.tokenSets++;
      if (redis.failTokenSets > 0) {
        redis.failTokenSets--;
        res.writeHead(500).end('{"error":"boom"}');
        return;
      }
    }
    const nx = cmd.includes('NX');
    const px = cmd.indexOf('PX');
    if (nx && get(key) !== null) result = null;
    else {
      redis.data.set(key, { v: cmd[2], exp: px > 0 ? now + Number(cmd[px + 1]) : undefined });
      result = 'OK';
    }
  } else if (op === 'DEL') result = redis.data.delete(key) ? 1 : 0;
  else if (op === 'EVAL') {
    const [, , , lockKey, owner] = cmd;
    result = get(lockKey) === owner ? (redis.data.delete(lockKey), 1) : 0;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ result }));
});

let mod: typeof import('../src/whoop-api.js');
let TokenStore: typeof import('../src/token-store.js').TokenStore;
let UpstashPersistence: typeof import('../src/persistence.js').UpstashPersistence;
let redisUrl = '';

before(async () => {
  await new Promise<void>((r) => whoopServer.listen(0, r));
  await new Promise<void>((r) => redisServer.listen(0, r));
  const wp = (whoopServer.address() as AddressInfo).port;
  redisUrl = `http://127.0.0.1:${(redisServer.address() as AddressInfo).port}`;
  process.env.WHOOP_OAUTH_BASE = `http://127.0.0.1:${wp}/oauth`;
  process.env.WHOOP_API_BASE = `http://127.0.0.1:${wp}/api`;
  mod = await import('../src/whoop-api.js');
  TokenStore = (await import('../src/token-store.js')).TokenStore;
  UpstashPersistence = (await import('../src/persistence.js')).UpstashPersistence;
});
after(() => {
  whoopServer.close();
  redisServer.close();
});

const config = { clientId: 'c', clientSecret: 's', redirectUri: 'https://example.test/callback' };

/** One "instance": its own memory, shared fake Redis. Seeds an already-expired access token. */
function instance(seedExpired = true) {
  const store = new TokenStore();
  store.setPersistence(new UpstashPersistence(redisUrl, 't'));
  const alerts: string[] = [];
  store.onAlert = (m) => alerts.push(m);
  if (seedExpired && whoop.chain) {
    redis.data.set('whoop:token', {
      v: JSON.stringify({ access_token: 'stale', refresh_token: whoop.chain.refresh, expires_at: Date.now() - 1, updated_at: 1 }),
    });
  }
  store.ready = store.hydrate().then(() => undefined);
  return { store, client: new mod.WhoopApiClient(config, store), alerts };
}

function reset() {
  whoop.chain = newChain();
  whoop.refreshCalls = 0;
  redis.data.clear();
  redis.failTokenSets = 0;
  redis.tokenSets = 0;
}

test('the fake reproduces the failure: two overlapping refreshes with one token kill the grant', async () => {
  reset();
  const rt = whoop.chain!.refresh;
  const { client } = instance(false);
  const results = await Promise.allSettled([client.refreshTokens(rt), client.refreshTokens(rt)]);
  // First wins, second reuses the token, and the reuse revokes the chain.
  await new Promise((r) => setTimeout(r, 20));
  const second = await Promise.allSettled([client.refreshTokens(rt)]);
  assert.ok(results.some((r) => r.status === 'rejected') || second[0].status === 'rejected');
  assert.equal(whoop.chain!.alive, false);
});

test('20 concurrent calls in one instance share a single refresh', async () => {
  reset();
  const { client } = instance();
  const out = await Promise.all(Array.from({ length: 20 }, () => client.getUserProfile()));
  assert.equal(out.length, 20);
  assert.equal(whoop.refreshCalls, 1);
  assert.equal(whoop.chain!.alive, true);
});

test('two instances refreshing at once use one refresh between them', async () => {
  reset();
  const a = instance();
  const b = instance(false);
  const calls = [
    ...Array.from({ length: 10 }, () => a.client.getUserProfile()),
    ...Array.from({ length: 10 }, () => b.client.getUserProfile()),
  ];
  await Promise.all(calls);
  assert.equal(whoop.refreshCalls, 1);
  assert.equal(whoop.chain!.alive, true);
  assert.equal(JSON.parse(redis.data.get('whoop:token')!.v).refresh_token, whoop.chain!.refresh);
});

test('repeated expiries over time keep the chain alive', async () => {
  reset();
  whoop.expiresIn = 61; // set() keeps 60 s of margin, so each token is "expired" after ~1 s
  const a = instance();
  const b = instance(false);
  for (let round = 0; round < 3; round++) {
    await Promise.all([a.client.getUserProfile(), b.client.getUserProfile(), a.client.getUserProfile()]);
    await new Promise((r) => setTimeout(r, 1100));
  }
  assert.equal(whoop.chain!.alive, true);
  assert.equal(whoop.refreshCalls, 3);
});

test('a rejected refresh token marks re-auth required and says where to go', async () => {
  reset();
  whoop.chain!.alive = false;
  const { client, store, alerts } = instance();
  await assert.rejects(client.getUserProfile(), /authorization expired.*https:\/\/example\.test\/authorize/);
  assert.equal(store.isAuthenticated(), false);
  assert.equal(store.getStatus().state, 'reauth_required');
  assert.equal(redis.data.has('whoop:token'), false);
  assert.equal(alerts.length, 1);
  // A fresh instance after restart also reports it, instead of "authenticated".
  const later = instance(false);
  await later.store.ready;
  assert.equal(later.store.isAuthenticated(), false);
});

test('a failed save is retried', async () => {
  reset();
  redis.failTokenSets = 2;
  const { client, store, alerts } = instance();
  await client.getUserProfile();
  assert.equal(redis.tokenSets, 3);
  assert.equal(JSON.parse(redis.data.get('whoop:token')!.v).refresh_token, whoop.chain!.refresh);
  assert.equal(store.getStatus().state, 'ok');
  assert.equal(alerts.length, 0);
});

test('a save that keeps failing alerts, and an older stored token never replaces the newer one', async () => {
  reset();
  redis.failTokenSets = 100;
  const { client, store, alerts } = instance();
  await client.getUserProfile();
  assert.equal(store.getStatus().state, 'degraded');
  assert.equal(alerts.length, 1);
  const inMemory = store.get()!.refresh_token;
  assert.equal(inMemory, whoop.chain!.refresh);
  await store.hydrate(); // Redis still holds the old (now used) token
  assert.equal(store.get()!.refresh_token, inMemory);
});
