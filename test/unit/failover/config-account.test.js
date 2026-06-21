import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { setAccountThresholds, clearAccountThresholds, loadConfig } from '../../../lib/config.js';
import { tmpHome, restoreHome } from '../../helpers/temp-home.js';

describe('config.js — per-account failover thresholds', () => {
  before(() => tmpHome());
  after(() => restoreHome());

  it('setAccountThresholds writes per-account thresholds', () => {
    saveTestConfig({ accounts: [{ name: 'foo', configDir: '/tmp/profiles/foo' }] });
    setAccountThresholds('foo', { switch_at: 60, switch_back_at: 30 });
    const account = loadConfig().accounts.find((a) => a.name === 'foo');
    assert.deepEqual(account.thresholds, { switch_at: 60, switch_back_at: 30 });
  });

  it('setAccountThresholds merges into existing thresholds (one key at a time)', () => {
    saveTestConfig({ accounts: [{ name: 'foo', configDir: '/tmp/profiles/foo' }] });
    setAccountThresholds('foo', { switch_at: 60, switch_back_at: 30 });
    setAccountThresholds('foo', { switch_back_at: 20 });
    const account = loadConfig().accounts.find((a) => a.name === 'foo');
    assert.deepEqual(account.thresholds, { switch_at: 60, switch_back_at: 20 });
  });

  it('clearAccountThresholds reverts to global', () => {
    saveTestConfig({ accounts: [{ name: 'foo', configDir: '/tmp/profiles/foo' }] });
    setAccountThresholds('foo', { switch_at: 60 });
    clearAccountThresholds('foo');
    const account = loadConfig().accounts.find((a) => a.name === 'foo');
    assert.equal(account.thresholds, undefined);
  });

  it('validates threshold values', () => {
    saveTestConfig({ accounts: [{ name: 'foo', configDir: '/tmp/profiles/foo' }] });
    assert.throws(() => setAccountThresholds('foo', { switch_at: 'abc' }), /integer/);
    assert.throws(() => setAccountThresholds('foo', { switch_at: 150 }), /0 and 100/);
    assert.throws(() => setAccountThresholds('foo', { switch_at: -1 }), /0 and 100/);
    assert.throws(() => setAccountThresholds('foo', { switch_at: 1.5 }), /integer/);
  });

  it('rejects unknown accounts', () => {
    saveTestConfig({ accounts: [{ name: 'foo', configDir: '/tmp/profiles/foo' }] });
    assert.throws(() => setAccountThresholds('nonexistent', { switch_at: 60 }), /not found/);
  });
});

function saveTestConfig(config) {
  const dir = join(process.env.HOME, '.claude-nonstop');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
}