import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { OAuthProvider, CustomEndpointProvider } from '../../../lib/failover/provider.js';

/**
 * Stub token resolver. Returns whatever token was registered for the
 * configDir, or null if none. Lets OAuthProvider think it has credentials
 * without going near the OS keychain.
 */
function makeTokenStore(tokens) {
  return (configDir) => tokens[configDir] ?? null;
}

describe('failover/provider.js — OAuthProvider', () => {
  it('names itself "oauth:<name>"', () => {
    const p = new OAuthProvider({ name: 'rahima', configDir: '/tmp/rahima', getToken: () => 'tok' });
    assert.equal(p.kind(), 'oauth');
    assert.equal(p.name(), 'oauth:rahima');
    assert.deepEqual(p.thresholdOverrides(), null);
  });

  it('exposes per-account thresholds', () => {
    const p = new OAuthProvider({
      name: 'a',
      configDir: '/tmp/a',
      getToken: () => 'tok',
      thresholds: { switch_at: 50, switch_back_at: 20 },
    });
    assert.deepEqual(p.thresholdOverrides(), { switch_at: 50, switch_back_at: 20 });
  });

  it('reports no_token when token is missing', async () => {
    const p = new OAuthProvider({ name: 'a', configDir: '/tmp/a', getToken: () => null });
    const u = await p.getUtilization();
    assert.equal(u.error, 'no_token');
    assert.equal(u.percent, null);
  });
});

describe('failover/provider.js — CustomEndpointProvider', () => {
  it('names itself "custom:<name>" and reports kind', () => {
    const p = new CustomEndpointProvider({
      name: 'proxy1',
      baseUrl: 'https://proxy.example.com',
      token: 'tok',
    });
    assert.equal(p.kind(), 'custom_endpoint');
    assert.equal(p.name(), 'custom:proxy1');
    assert.deepEqual(p.thresholdOverrides(), null);
  });

  it('exposes per-account thresholds', () => {
    const p = new CustomEndpointProvider({
      name: 'proxy2',
      baseUrl: 'https://proxy2.example.com',
      token: 'tok',
      thresholds: { switch_at: 70, switch_back_at: 30 },
    });
    assert.deepEqual(p.thresholdOverrides(), { switch_at: 70, switch_back_at: 30 });
  });

  it('reports utilization 0 with unknown flag (custom endpoints have no Anthropic-side quota)', async () => {
    const p = new CustomEndpointProvider({
      name: 'p',
      baseUrl: 'https://p.example.com',
      token: 'tok',
    });
    const u = await p.getUtilization();
    assert.equal(u.percent, 0);
    assert.equal(u.error, null);
    assert.equal(u.unknown, true);
  });

  it('exposes connection info for env-var injection', () => {
    const p = new CustomEndpointProvider({
      name: 'p',
      baseUrl: 'https://p.example.com/',
      token: 'sk-test',
      model: 'claude-sonnet-4-5',
    });
    const info = p.getConnectionInfo();
    assert.equal(info.baseUrl, 'https://p.example.com'); // trailing slash stripped
    assert.equal(info.token, 'sk-test');
    assert.equal(info.model, 'claude-sonnet-4-5');
  });

  it('isHealthy uses GET /v1/models with Bearer token', async () => {
    let capturedUrl, capturedHeaders;
    globalThis.fetch = async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init?.headers ?? {};
      return new Response('', { status: 200 });
    };
    const p = new CustomEndpointProvider({
      name: 'p',
      baseUrl: 'https://p.example.com',
      token: 'tok',
    });
    const ok = await p.isHealthy();
    assert.equal(ok, true);
    assert.equal(capturedUrl, 'https://p.example.com/v1/models');
    assert.equal(capturedHeaders.Authorization, 'Bearer tok');
  });

  it('isHealthy caches for 30s', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('', { status: 200 }); };
    const p = new CustomEndpointProvider({
      name: 'p',
      baseUrl: 'https://p.example.com',
      token: 'tok',
    });
    await p.isHealthy();
    await p.isHealthy();
    await p.isHealthy();
    assert.equal(calls, 1);
  });

  it('isHealthy returns false on non-2xx', async () => {
    globalThis.fetch = async () => new Response('', { status: 502 });
    const p = new CustomEndpointProvider({
      name: 'p',
      baseUrl: 'https://p.example.com',
      token: 'tok',
    });
    const ok = await p.isHealthy();
    assert.equal(ok, false);
  });

  it('isHealthy returns false on fetch error', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    const p = new CustomEndpointProvider({
      name: 'p',
      baseUrl: 'https://p.example.com',
      token: 'tok',
    });
    const ok = await p.isHealthy();
    assert.equal(ok, false);
  });
});