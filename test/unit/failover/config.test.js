import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

import { loadFailoverConfig } from '../../../lib/failover/monitor.js';

/**
 * Tests for the config schema and threshold keys.
 *
 * We don't write to the real ~/.claude-nonstop/failover.json in tests — we
 * pass an explicit configPath and use tmpdir.
 */
describe('failover/monitor.js — loadFailoverConfig', () => {
  let dir;
  let cfgPath;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'cns-failover-cfg-'));
    cfgPath = join(dir, 'failover.json');
  });

  after(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  it('returns defaults when file does not exist', () => {
    const cfg = loadFailoverConfig('/tmp/cns-does-not-exist.json');
    assert.equal(cfg.thresholds.switch_at, 80);
    assert.equal(cfg.thresholds.switch_back_at, 50);
    assert.deepEqual(cfg.peers, []);
  });

  it('accepts new (switch_at / switch_back_at) keys', () => {
    writeFileSync(cfgPath, JSON.stringify({
      peers: [{ name: 'p1', baseUrl: 'https://p1.example.com' }],
      thresholds: { switch_at: 70, switch_back_at: 30, recheck_interval_seconds: 120 },
    }));
    const cfg = loadFailoverConfig(cfgPath);
    assert.equal(cfg.thresholds.switch_at, 70);
    assert.equal(cfg.thresholds.switch_back_at, 30);
    assert.equal(cfg.thresholds.recheck_interval_seconds, 120);
    assert.equal(cfg.peers.length, 1);
  });

  it('translates legacy keys (switch_to_fallback_at → switch_at)', () => {
    writeFileSync(cfgPath, JSON.stringify({
      fallback: { kind: 'custom_endpoint', baseUrl: 'https://fb.example.com' },
      thresholds: { switch_to_fallback_at: 90, switch_back_at: 60 },
    }));
    const cfg = loadFailoverConfig(cfgPath);
    assert.equal(cfg.thresholds.switch_at, 90);
    assert.equal(cfg.thresholds.switch_back_at, 60);
  });

  it('mixed legacy + new keys: new wins when both present', () => {
    writeFileSync(cfgPath, JSON.stringify({
      thresholds: { switch_to_fallback_at: 90, switch_at: 70 },
    }));
    const cfg = loadFailoverConfig(cfgPath);
    // new key takes precedence
    assert.equal(cfg.thresholds.switch_at, 70);
  });

  it('falls back to defaults on parse error', () => {
    writeFileSync(cfgPath, 'not json {{{');
    const cfg = loadFailoverConfig(cfgPath);
    assert.equal(cfg.thresholds.switch_at, 80);
  });

  it('per-peer thresholds survive load', () => {
    writeFileSync(cfgPath, JSON.stringify({
      peers: [
        { name: 'tight', baseUrl: 'https://t.example.com', thresholds: { switch_at: 50, switch_back_at: 20 } },
        { name: 'loose', baseUrl: 'https://l.example.com', thresholds: { switch_at: 95 } },
      ],
    }));
    const cfg = loadFailoverConfig(cfgPath);
    assert.deepEqual(cfg.peers[0].thresholds, { switch_at: 50, switch_back_at: 20 });
    assert.deepEqual(cfg.peers[1].thresholds, { switch_at: 95 });
  });
});