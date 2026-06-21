/**
 * Failover state machine.
 *
 * Owns the active-provider decision. Polls the OAuth/custom pool on a timer
 * (or synchronously via tick()), decides whether to switch, and atomically
 * writes the active provider to a state file consumed by the runner/wrapper.
 *
 *   state file: ~/.claude-nonstop/state/active.json
 *     {
 *       "provider": "primary" | "custom:<name>",
 *       "account":  "<oauth account name>" | null,
 *       "reason":   string,
 *       "at":       ISO-8601 timestamp,
 *       "primary_utilization": 0-100 | null,
 *       "last_check": { at, ok, percent, error },
 *       "connection": { baseUrl, model } | null    -- set when on a custom peer
 *     }
 *
 * Thresholds (configurable per-account and globally in failover.json):
 *   switch_at:       best OAuth account >= X → switch to custom peer
 *   switch_back_at:  best OAuth account <= Y → switch back to primary
 *   recheck_interval_seconds: poll cadence (default 60)
 *
 * "Primary" = the OAuth account pool (all claude-nonstop registered accounts).
 * The monitor picks the lowest-utilization OAuth account. If none are below
 * threshold, it falls back to the first healthy custom endpoint peer.
 *
 * Hysteresis prevents flapping: once on a custom peer, only revert when the
 * best OAuth drops well below the original trigger (switch_back_at, 50% default).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

import { getBestProviderOrNull } from './pool.js';

const STATE_DIR = join(homedir(), '.claude-nonstop', 'state');
const STATE_FILE = join(STATE_DIR, 'active.json');
const LOG_FILE = join(homedir(), '.claude-nonstop', 'logs', 'failover.log');

const DEFAULT_CONFIG = {
  primary: null,
  fallback: null,
  peers: [],
  thresholds: {
    switch_at: 80,
    switch_back_at: 50,
    recheck_interval_seconds: 60,
  },
  logging: { path: LOG_FILE },
};

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

export function loadFailoverConfig(configPath) {
  if (!configPath || !existsSync(configPath)) return structuredClone(DEFAULT_CONFIG);
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));

    // Normalize legacy threshold keys for backward compatibility
    const mergedThresholds = { ...DEFAULT_CONFIG.thresholds };
    if (raw.thresholds) {
      mergedThresholds.switch_at = raw.thresholds.switch_at
        ?? raw.thresholds.switch_to_fallback_at
        ?? DEFAULT_CONFIG.thresholds.switch_at;
      mergedThresholds.switch_back_at = raw.thresholds.switch_back_at
        ?? DEFAULT_CONFIG.thresholds.switch_back_at;
      mergedThresholds.recheck_interval_seconds = raw.thresholds.recheck_interval_seconds
        ?? DEFAULT_CONFIG.thresholds.recheck_interval_seconds;
    }

    return {
      ...structuredClone(DEFAULT_CONFIG),
      ...raw,
      thresholds: mergedThresholds,
      logging: { ...DEFAULT_CONFIG.logging, ...(raw.logging ?? {}) },
      peers: Array.isArray(raw.peers) ? raw.peers : [],
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function loadActiveState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function writeActiveState(state) {
  ensureDir(dirname(STATE_FILE));
  const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, STATE_FILE);
}

function appendLog(line) {
  try {
    ensureDir(dirname(LOG_FILE));
    const ts = new Date().toISOString();
    const full = `[${ts}] ${line}\n`;
    const prev = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf-8') : '';
    const trimmed = prev.length > 64_000 ? prev.slice(-32_000) : prev;
    writeFileSync(LOG_FILE, trimmed + full, { mode: 0o600 });
  } catch {
    // Logging must never break failover.
  }
}

/**
 * Normalise the current provider string from the state file.
 *
 * @param {string} raw
 * @returns {"primary"|string} "primary" or "custom:<name>" (or legacy "fallback")
 */
function normalizeCurrentProvider(raw) {
  if (!raw || raw === 'primary') return 'primary';
  if (raw === 'fallback') return 'fallback'; // legacy compat
  if (raw.startsWith('custom:')) return raw;
  if (raw.startsWith('peer:')) return raw.replace('peer:', 'custom:'); // legacy
  return 'primary';
}

/**
 * Decide target provider from current state and a fresh pool reading.
 *
 * @param {string} current - "primary" | "fallback" | "custom:<name>"
 * @param {{ best: { provider, reading }|null, bestPeer: import('./provider.js').CustomEndpointProvider|null, all: Array }} poolResult
 * @param {{ switch_at: number, switch_back_at: number }} thresholds
 * @returns {{ target: string, account?: string, peer?: string, connection?: object, reason: string } | null}
 */
export function decide(current, poolResult, thresholds) {
  const { best, bestPeer, all } = poolResult;

  const oauthAll = all.filter((a) => !a.isPeer);
  const errorCount = oauthAll.filter((a) => a.error).length;
  const bestPercent = best?.reading?.percent ?? null;

  const isOnCustom = current !== 'primary';

  if (oauthAll.length === 0) {
    if (isOnCustom) return null;
    if (bestPeer) {
      return {
        target: bestPeer.name(),
        peer: bestPeer.name(),
        connection: bestPeer.getConnectionInfo(),
        reason: 'no_oauth_accounts',
      };
    }
    return null;
  }

  if (current === 'primary') {
    if (!best) {
      // All OAuth exhausted — pick best peer
      if (bestPeer) {
        return {
          target: bestPeer.name(),
          peer: bestPeer.name(),
          connection: bestPeer.getConnectionInfo(),
          reason: 'all_oauth_above_threshold',
        };
      }
      return null;
    }
    if (bestPercent != null && bestPercent >= thresholds.switch_at) {
      if (bestPeer) {
        return {
          target: bestPeer.name(),
          peer: bestPeer.name(),
          connection: bestPeer.getConnectionInfo(),
          reason: `best_oauth_at_${bestPercent}pct`,
        };
      }
      return null;
    }
    if (errorCount === oauthAll.length) {
      if (bestPeer) {
        return {
          target: bestPeer.name(),
          peer: bestPeer.name(),
          connection: bestPeer.getConnectionInfo(),
          reason: 'all_oauth_erroring',
        };
      }
      return null;
    }
    return null;
  }

  // Currently on a custom provider — decide whether to switch back.
  if (!best) return null;

  // Use per-peer switch_back_at if the current peer has an override.
  let switchBackAt = thresholds.switch_back_at;
  if (bestPeer) {
    const override = bestPeer.thresholdOverrides()?.switch_back_at;
    if (override != null) switchBackAt = override;
  }

  if (bestPercent != null && bestPercent <= switchBackAt) {
    return {
      target: 'primary',
      account: best.provider.name(),
      reason: `best_oauth_recovered_${bestPercent}pct_${best.provider.name()}`,
    };
  }
  return null;
}

export class FailoverMonitor {
  /**
   * @param {{
   *   thresholds: { switch_at: number, switch_back_at: number, recheck_interval_seconds: number },
   *   cfg?: object,
   *   log?: (line: string) => void,
   *   statePath?: string,
   * }} opts
   */
  constructor({ thresholds, cfg, log, statePath }) {
    this._thresholds = thresholds;
    this._cfg = cfg ?? null;
    this._log = log ?? appendLog;
    this._statePath = statePath ?? STATE_FILE;
    this._timer = null;
    this._stopped = false;
  }

  _readActive() {
    if (!existsSync(this._statePath)) return { provider: 'primary', account: null };
    try {
      const s = JSON.parse(readFileSync(this._statePath, 'utf-8'));
      return {
        provider: normalizeCurrentProvider(s.provider),
        account: s.account ?? null,
      };
    } catch {
      return { provider: 'primary', account: null };
    }
  }

  async tick() {
    const poolResult = await getBestProviderOrNull(this._thresholds, this._cfg);
    const { provider: current, account: currentAccount } = this._readActive();
    const decision = decide(current, poolResult, this._thresholds);

    const bestPercent = poolResult.best?.reading?.percent ?? null;
    const oauthAll = poolResult.all.filter((a) => !a.isPeer);
    const allSummary = poolResult.all
      .map((a) => `${a.name}=${a.percent ?? '?'}${a.error ? `(err=${a.error})` : ''}${a.isPeer ? '(peer)' : ''}`)
      .join(' ');

    const targetProvider = decision ? decision.target : current;
    const state = {
      provider: targetProvider,
      account: (decision?.account ?? poolResult.best?.provider.name() ?? currentAccount) ?? null,
      reason: decision?.reason ?? (current !== 'primary' ? `on_${current}` : 'on_primary'),
      at: new Date().toISOString(),
      primary_utilization: bestPercent,
      primary_account: poolResult.best?.provider.name() ?? null,
      connection: decision?.connection ?? null,
      pool: poolResult.all,
      last_check: {
        at: new Date().toISOString(),
        ok: oauthAll.some((a) => !a.error),
        percent: bestPercent,
        error: oauthAll.find((a) => a.error)?.error ?? null,
      },
    };

    writeActiveState(state);

    if (decision) {
      this._log(
        `SWITCH ${current}→${decision.target} account=${state.account ?? '-'} ` +
        `reason=${decision.reason} best=${bestPercent ?? '?'}% | ${allSummary}`
      );
    } else {
      this._log(
        `CHECK active=${state.provider} account=${state.account ?? '-'} ` +
        `best=${bestPercent ?? '?'}% | ${allSummary}`
      );
    }

    return state;
  }

  start() {
    if (this._timer) return;
    this._stopped = false;
    const intervalMs = Math.max(30, this._thresholds.recheck_interval_seconds) * 1000;
    this.tick().catch((err) => this._log(`TICK_ERROR ${err.message}`));
    this._timer = setInterval(() => {
      if (this._stopped) return;
      this.tick().catch((err) => this._log(`TICK_ERROR ${err.message}`));
    }, intervalMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

export { STATE_FILE, LOG_FILE };
