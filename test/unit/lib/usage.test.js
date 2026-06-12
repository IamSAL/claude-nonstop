import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePercent, checkUsage, fetchProfile, checkAllUsage } from '../../../lib/usage.js';

describe('normalizePercent', () => {
  it('converts 0.5 fraction to 50%', () => {
    assert.equal(normalizePercent(0.5), 50);
  });

  it('converts 0.72 fraction to 72%', () => {
    assert.equal(normalizePercent(0.72), 72);
  });

  it('keeps 75 as 75 (already a percentage)', () => {
    assert.equal(normalizePercent(75), 75);
  });

  it('keeps 100 as 100', () => {
    assert.equal(normalizePercent(100), 100);
  });

  it('returns 0 for NaN', () => {
    assert.equal(normalizePercent(NaN), 0);
  });

  it('returns 0 for non-number', () => {
    assert.equal(normalizePercent('hello'), 0);
    assert.equal(normalizePercent(null), 0);
    assert.equal(normalizePercent(undefined), 0);
  });

  it('handles 0', () => {
    assert.equal(normalizePercent(0), 0);
  });

  it('handles 1.0 as 100%', () => {
    assert.equal(normalizePercent(1.0), 100);
  });

  it('rounds negative values', () => {
    assert.equal(normalizePercent(-5), -5);
  });

  it('rounds fractional percentages', () => {
    assert.equal(normalizePercent(0.333), 33);
  });
});

describe('checkUsage', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('parses new nested format', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 0.42, resets_at: '2026-02-15T12:00:00Z' },
        seven_day: { utilization: 0.75, resets_at: '2026-02-20T00:00:00Z' },
      }),
    });

    const result = await checkUsage('sk-ant-oat01-test');
    assert.equal(result.sessionPercent, 42);
    assert.equal(result.weeklyPercent, 75);
    assert.equal(result.sessionResetsAt, '2026-02-15T12:00:00Z');
    assert.equal(result.weeklyResetsAt, '2026-02-20T00:00:00Z');
    assert.equal(result.error, null);
  });

  it('parses legacy flat format', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        five_hour_utilization: 0.30,
        seven_day_utilization: 0.60,
        five_hour_reset_at: '2026-02-15T12:00:00Z',
        seven_day_reset_at: '2026-02-20T00:00:00Z',
      }),
    });

    const result = await checkUsage('sk-ant-oat01-test');
    assert.equal(result.sessionPercent, 30);
    assert.equal(result.weeklyPercent, 60);
    assert.equal(result.error, null);
  });

  it('returns error for HTTP errors', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
    });

    const result = await checkUsage('sk-ant-oat01-test');
    assert.equal(result.error, 'HTTP 401');
    assert.equal(result.sessionPercent, 0);
  });

  it('returns timeout error on AbortError', async () => {
    globalThis.fetch = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };

    const result = await checkUsage('sk-ant-oat01-test');
    assert.equal(result.error, 'timeout');
  });

  it('returns error message for other errors', async () => {
    globalThis.fetch = async () => {
      throw new Error('Network failure');
    };

    const result = await checkUsage('sk-ant-oat01-test');
    assert.equal(result.error, 'Network failure');
  });
});

describe('fetchProfile', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('extracts name and email', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        account: { full_name: 'Test User', email: 'test@example.com' },
      }),
    });

    const result = await fetchProfile('sk-ant-oat01-test');
    assert.equal(result.name, 'Test User');
    assert.equal(result.email, 'test@example.com');
  });

  it('returns nulls on error', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
    });

    const result = await fetchProfile('sk-ant-oat01-test');
    assert.equal(result.name, null);
    assert.equal(result.email, null);
  });

  it('returns nulls on network error', async () => {
    globalThis.fetch = async () => { throw new Error('fail'); };

    const result = await fetchProfile('sk-ant-oat01-test');
    assert.equal(result.name, null);
    assert.equal(result.email, null);
  });

  it('uses display_name fallback', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        account: { display_name: 'Display Name', email: 'test@example.com' },
      }),
    });

    const result = await fetchProfile('sk-ant-oat01-test');
    assert.equal(result.name, 'Display Name');
  });

  it('extracts organization identity (uuid, name, type) and account uuid', async () => {
    // Real shape returned by api.anthropic.com/api/oauth/profile for an
    // enterprise email account that has both an enterprise org and a personal
    // Max plan org under the same email, per company policy.
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        account: { uuid: 'acct-123', full_name: 'Alice Example', email: 'alice@example.com', has_claude_max: true },
        organization: { uuid: 'org-ent-uuid', name: 'Acme Corp', organization_type: 'claude_enterprise' },
      }),
    });

    const r = await fetchProfile('sk-ant-oat01-test');
    assert.equal(r.email, 'alice@example.com');
    assert.equal(r.orgId, 'org-ent-uuid');
    assert.equal(r.orgName, 'Acme Corp');
    assert.equal(r.orgType, 'claude_enterprise');
    assert.equal(r.accountUuid, 'acct-123');
  });

  it('distinguishes two orgs under the SAME email by orgId', async () => {
    const byOrg = {
      'sk-ant-oat01-max': {
        account: { uuid: 'acct-1', email: 'alice@example.com' },
        organization: { uuid: 'org-max', name: 'Personal', organization_type: 'claude_max' },
      },
      'sk-ant-oat01-ent': {
        account: { uuid: 'acct-1', email: 'alice@example.com' },
        organization: { uuid: 'org-ent', name: 'Acme Corp', organization_type: 'claude_enterprise' },
      },
    };
    globalThis.fetch = async (_url, opts) => {
      const token = opts.headers.Authorization.replace('Bearer ', '');
      return { ok: true, json: async () => byOrg[token] };
    };

    const max = await fetchProfile('sk-ant-oat01-max');
    const ent = await fetchProfile('sk-ant-oat01-ent');
    // Same email, same account uuid — but DIFFERENT org identity.
    assert.equal(max.email, ent.email);
    assert.equal(max.accountUuid, ent.accountUuid);
    assert.notEqual(max.orgId, ent.orgId);
  });

  it('returns null org fields when organization is absent (email-only fallback)', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ account: { email: 'solo@example.com', full_name: 'Solo' } }),
    });
    const r = await fetchProfile('sk-ant-oat01-test');
    assert.equal(r.orgId, null);
    assert.equal(r.orgName, null);
    assert.equal(r.email, 'solo@example.com');
  });

  it('returns null org fields on HTTP error and on network error', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    let r = await fetchProfile('sk-ant-oat01-test');
    assert.equal(r.orgId, null);
    assert.equal(r.orgName, null);

    globalThis.fetch = async () => { throw new Error('net'); };
    r = await fetchProfile('sk-ant-oat01-test');
    assert.equal(r.orgId, null);
    assert.equal(r.accountUuid, null);
  });
});

describe('checkAllUsage', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('checks all accounts in parallel and preserves order', async () => {
    // Use token to deterministically map to different data (avoids race on shared counter)
    const usageByToken = {
      'sk-ant-oat01-a': { five_hour: { utilization: 0.20 }, seven_day: { utilization: 0.10 } },
      'sk-ant-oat01-b': { five_hour: { utilization: 0.60 }, seven_day: { utilization: 0.40 } },
    };

    globalThis.fetch = async (_url, opts) => {
      const token = opts.headers.Authorization.replace('Bearer ', '');
      return {
        ok: true,
        json: async () => usageByToken[token] || {},
      };
    };

    const accounts = [
      { name: 'a', configDir: '/tmp/a', token: 'sk-ant-oat01-a' },
      { name: 'b', configDir: '/tmp/b', token: 'sk-ant-oat01-b' },
    ];

    const results = await checkAllUsage(accounts);
    assert.equal(results.length, 2);
    // Order is preserved
    assert.equal(results[0].name, 'a');
    assert.equal(results[1].name, 'b');
    // Deterministic values based on token
    assert.equal(results[0].usage.sessionPercent, 20);
    assert.equal(results[0].usage.weeklyPercent, 10);
    assert.equal(results[1].usage.sessionPercent, 60);
    assert.equal(results[1].usage.weeklyPercent, 40);
    assert.equal(results[0].usage.error, null);
    assert.equal(results[1].usage.error, null);
  });
});
