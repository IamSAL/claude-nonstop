import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { tmpHome, restoreHome } from '../../helpers/temp-home.js';

/**
 * Tests for lib/failover/active.js — the non-TTY auto-promote behavior.
 *
 * We mock `resolveProvider` indirectly by pointing HOME at a tempdir where we
 * write the active.json state file and failover.json config. We stub fetch
 * so the health check doesn't actually hit a network.
 *
 * Because active.js eagerly resolves the failover config and builds peers,
 * we need to be careful about which paths run synchronously vs async.
 */

let savedFetch;

describe('failover/active.js — resolveProvider (non-TTY auto-promote)', () => {
  before(() => {
    tmpHome();
    savedFetch = globalThis.fetch;
    // Stub fetch so peer.isHealthy() doesn't hit the network
    globalThis.fetch = async (url) => {
      // Only the peer health probe should reach here; everything else is
      // local to the test. We return 200 for /v1/models endpoints.
      if (typeof url === 'string' && url.includes('/v1/models')) {
        return new Response('', { status: 200 });
      }
      return new Response('', { status: 200 });
    };
  });

  after(() => {
    restoreHome();
    if (savedFetch) globalThis.fetch = savedFetch;
  });

  it('returns primary in interactive mode with no state file', async () => {
    const { resolveProvider } = await import('../../../lib/failover/active.js');
    const r = await resolveProvider({ isInteractive: true });
    assert.equal(r.provider, 'primary');
    assert.equal(r.autoPromoted, false);
  });

  it('auto-promotes to first healthy peer in non-interactive mode', async () => {
    // Set up a failover.json with one custom peer
    const cfgDir = join(process.env.HOME, '.claude-nonstop');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'failover.json'), JSON.stringify({
      peers: [
        { name: 'p1', baseUrl: 'https://p1.example.com', authToken: 'tok-p1' },
      ],
      thresholds: { switch_at: 80, switch_back_at: 50 },
    }));

    const { resolveProvider } = await import('../../../lib/failover/active.js');
    const r = await resolveProvider({ isInteractive: false });
    assert.equal(r.autoPromoted, true);
    assert.equal(r.provider, 'custom:p1');
    assert.equal(r.connection.baseUrl, 'https://p1.example.com');
    assert.equal(r.connection.token, 'tok-p1');
  });

  it('does NOT auto-promote when a state file already says custom:<other>', async () => {
    // State file says we're on custom:p2 (already decided). Non-TTY mode
    // should honor that decision, not auto-promote to p1.
    const cfgDir = join(process.env.HOME, '.claude-nonstop');
    mkdirSync(join(cfgDir, 'state'), { recursive: true });
    writeFileSync(join(cfgDir, 'failover.json'), JSON.stringify({
      peers: [
        { name: 'p1', baseUrl: 'https://p1.example.com', authToken: 'tok-p1' },
        { name: 'p2', baseUrl: 'https://p2.example.com', authToken: 'tok-p2' },
      ],
    }));
    writeFileSync(join(cfgDir, 'state', 'active.json'), JSON.stringify({
      provider: 'custom:p2',
      account: null,
      connection: { baseUrl: 'https://p2.example.com', token: 'tok-p2', model: 'auto' },
      reason: 'monitor_decision',
      at: new Date().toISOString(),
    }));

    const { resolveProvider } = await import('../../../lib/failover/active.js');
    const r = await resolveProvider({ isInteractive: false });
    assert.equal(r.autoPromoted, false);
    assert.equal(r.provider, 'custom:p2');
    assert.equal(r.connection.token, 'tok-p2');
  });

  it('returns primary when no state file AND no peers AND interactive', async () => {
    // No state file at all → return primary.
    const stateFile = join(process.env.HOME, '.claude-nonstop', 'state', 'active.json');
    try { unlinkSync(stateFile); } catch {}
    writeFileSync(join(process.env.HOME, '.claude-nonstop', 'failover.json'), JSON.stringify({ peers: [], thresholds: {} }));

    const { resolveProvider } = await import('../../../lib/failover/active.js');
    const r = await resolveProvider({ isInteractive: true });
    assert.equal(r.provider, 'primary');
    assert.equal(r.autoPromoted, false);
  });

  it('falls through to primary in non-TTY mode when no peers are configured', async () => {
    // State file says primary → no auto-promote happens (state honors monitor decision).
    writeFileSync(join(process.env.HOME, '.claude-nonstop', 'state', 'active.json'),
      JSON.stringify({ provider: 'primary', account: null, connection: null, reason: 'on_primary', at: new Date().toISOString() }));
    writeFileSync(join(process.env.HOME, '.claude-nonstop', 'failover.json'), JSON.stringify({ peers: [] }));

    const { resolveProvider } = await import('../../../lib/failover/active.js');
    const r = await resolveProvider({ isInteractive: false });
    // No peers → can't auto-promote → primary (which will prompt OAuth, but
    // that's the only option left).
    assert.equal(r.provider, 'primary');
    assert.equal(r.autoPromoted, false);
  });

  it('honors state file in interactive mode (does NOT auto-promote)', async () => {
    const cfgDir = join(process.env.HOME, '.claude-nonstop');
    mkdirSync(join(cfgDir, 'state'), { recursive: true });
    writeFileSync(join(cfgDir, 'failover.json'), JSON.stringify({
      peers: [{ name: 'p1', baseUrl: 'https://p1.example.com', authToken: 'tok' }],
    }));
    writeFileSync(join(cfgDir, 'state', 'active.json'), JSON.stringify({
      provider: 'primary',
      account: 'oauth:foo',
      connection: null,
      reason: 'on_primary',
      at: new Date().toISOString(),
    }));

    const { resolveProvider } = await import('../../../lib/failover/active.js');
    const r = await resolveProvider({ isInteractive: true });
    // Interactive + primary state file → stay on primary. No auto-promote.
    assert.equal(r.provider, 'primary');
    assert.equal(r.autoPromoted, false);
    assert.equal(r.account, 'oauth:foo');
  });
});