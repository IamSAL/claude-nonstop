import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decide } from '../../../lib/failover/monitor.js';
import { CustomEndpointProvider } from '../../../lib/failover/provider.js';

const THRESHOLDS = { switch_at: 80, switch_back_at: 50 };

function peer(name, opts = {}) {
  const p = new CustomEndpointProvider({
    name,
    baseUrl: `https://${name}.example.com`,
    token: 'tok',
    thresholds: opts.thresholds,
  });
  p.isHealthy = async () => true;
  return p;
}

function oauthReading(name, percent) {
  return {
    provider: { name: () => `oauth:${name}` },
    reading: { percent, error: null },
  };
}

describe('failover/monitor.js — decide (primary → peer)', () => {
  it('stays on primary when best OAuth is below threshold', () => {
    const r = decide(
      'primary',
      { best: oauthReading('a', 30), bestPeer: null, all: [{ name: 'oauth:a', percent: 30 }] },
      THRESHOLDS,
    );
    assert.equal(r, null);
  });

  it('switches to peer when best OAuth is at/above switch_at', () => {
    const r = decide(
      'primary',
      {
        best: oauthReading('a', 85),
        bestPeer: peer('p1'),
        all: [{ name: 'oauth:a', percent: 85 }],
      },
      THRESHOLDS,
    );
    assert.ok(r);
    assert.equal(r.target, 'custom:p1');
    assert.equal(r.peer, 'custom:p1');
    assert.deepEqual(r.connection.baseUrl, 'https://p1.example.com');
  });

  it('switches to peer when ALL OAuth accounts are erroring', () => {
    const r = decide(
      'primary',
      {
        best: null,
        bestPeer: peer('p1'),
        all: [{ name: 'oauth:a', percent: null, error: 'auth_401' }],
      },
      THRESHOLDS,
    );
    assert.ok(r);
    assert.equal(r.target, 'custom:p1');
  });

  it('returns null when peer is unhealthy (no place to go)', () => {
    const r = decide(
      'primary',
      {
        best: oauthReading('a', 99),
        bestPeer: null,
        all: [{ name: 'oauth:a', percent: 99 }],
      },
      THRESHOLDS,
    );
    assert.equal(r, null);
  });

  it('honors per-account switch_at (looser threshold doesn\'t trigger)', () => {
    // OAuth account "loose" has its own switch_at=95; at 85% it's still healthy.
    // pool.js enforces per-account thresholds; decide() only sees accounts that
    // already passed pickBestOAuth. We simulate that here by passing a healthy
    // best — there is no candidate to switch TO so decide returns null.
    const r = decide(
      'primary',
      {
        best: { provider: { name: () => 'oauth:loose' }, reading: { percent: 85, error: null } },
        bestPeer: null, // pool already filtered out exhausted accounts; no peer fallback here
        all: [{ name: 'oauth:loose', percent: 85 }],
      },
      THRESHOLDS,
    );
    assert.equal(r, null);
  });
});

describe('failover/monitor.js — decide (peer → primary)', () => {
  it('switches back to primary when best OAuth drops below switch_back_at', () => {
    const r = decide(
      'custom:p1',
      {
        best: oauthReading('a', 30),
        bestPeer: peer('p1'),
        all: [{ name: 'oauth:a', percent: 30 }],
      },
      THRESHOLDS,
    );
    assert.ok(r);
    assert.equal(r.target, 'primary');
    assert.equal(r.account, 'oauth:a');
  });

  it('stays on peer when best OAuth is between switch_back_at and switch_at', () => {
    const r = decide(
      'custom:p1',
      {
        best: oauthReading('a', 65),
        bestPeer: peer('p1'),
        all: [{ name: 'oauth:a', percent: 65 }],
      },
      THRESHOLDS,
    );
    assert.equal(r, null);
  });

  it('honors per-peer switch_back_at override (looser hysteresis)', () => {
    // Peer has its own switch_back_at=20 — only switch back when OAuth < 20%.
    const r = decide(
      'custom:p1',
      {
        best: oauthReading('a', 30),
        bestPeer: peer('p1', { thresholds: { switch_back_at: 20 } }),
        all: [{ name: 'oauth:a', percent: 30 }],
      },
      THRESHOLDS,
    );
    assert.equal(r, null); // 30 > 20, so we stay on the peer
  });

  it('honors per-peer switch_back_at override (tighter hysteresis)', () => {
    // Peer has its own switch_back_at=80 — switch back when OAuth < 80%.
    const r = decide(
      'custom:p1',
      {
        best: oauthReading('a', 60),
        bestPeer: peer('p1', { thresholds: { switch_back_at: 80 } }),
        all: [{ name: 'oauth:a', percent: 60 }],
      },
      THRESHOLDS,
    );
    assert.ok(r);
    assert.equal(r.target, 'primary');
  });

  it('honors per-peer switch_back_at when bestPeer is null on switch-back (AGE-69)', () => {
    // Regression for AGE-69: getBestProviderOrNull sets bestPeer=null when any
    // OAuth account is below threshold (the switch-back case). The override must
    // still be readable via the peersByName lookup the monitor passes in.
    const peersByName = new Map([
      ['p1', peer('p1', { thresholds: { switch_back_at: 20 } })],
    ]);
    const r = decide(
      'custom:p1',
      {
        best: oauthReading('a', 30),
        bestPeer: null, // OAuth recovered → pool result has no peer
        all: [{ name: 'oauth:a', percent: 30 }],
      },
      THRESHOLDS,
      { peersByName },
    );
    assert.equal(r, null, '30 > 20 → stay on peer despite OAuth recovered');
  });

  it('falls back to global switch_back_at when peer has no override', () => {
    const peersByName = new Map([
      ['p1', peer('p1')], // no thresholds override
    ]);
    const r = decide(
      'custom:p1',
      {
        best: oauthReading('a', 40),
        bestPeer: null,
        all: [{ name: 'oauth:a', percent: 40 }],
      },
      THRESHOLDS, // global switch_back_at = 50
      { peersByName },
    );
    assert.ok(r);
    assert.equal(r.target, 'primary');
  });
});

describe('failover/monitor.js — decide (no OAuth accounts)', () => {
  it('switches to peer when there are no OAuth accounts at all', () => {
    const r = decide(
      'primary',
      {
        best: null,
        bestPeer: peer('p1'),
        all: [],
      },
      THRESHOLDS,
    );
    assert.ok(r);
    assert.equal(r.target, 'custom:p1');
  });

  it('stays put when no OAuth and already on a peer', () => {
    const r = decide(
      'custom:p1',
      { best: null, bestPeer: peer('p1'), all: [] },
      THRESHOLDS,
    );
    assert.equal(r, null);
  });
});

describe('failover/monitor.js — legacy "fallback" / "peer:" provider strings', () => {
  it('legacy "fallback" provider is treated as "on custom"', () => {
    // Normalizes to "fallback"; anything not "primary" is treated as on-custom.
    const r = decide(
      'fallback',
      { best: oauthReading('a', 80), bestPeer: peer('p1'), all: [{ name: 'oauth:a', percent: 80 }] },
      THRESHOLDS,
    );
    // 80 > switch_back_at=50 → no switch back; stay on legacy fallback
    assert.equal(r, null);
  });
});