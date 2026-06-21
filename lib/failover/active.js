/**
 * Read the active failover state from disk.
 *
 * Used by the runner to apply environment variables (ANTHROPIC_BASE_URL,
 * ANTHROPIC_AUTH_TOKEN) before spawning `claude` when the failover monitor
 * has decided to switch to a custom endpoint.
 *
 * When stdin is not a TTY (e.g. paperclip piped runs), this function
 * additionally honors the non-TTY auto-promote rule: if the current
 * provider is "primary" and there is any healthy custom endpoint peer in
 * the configured failover.json, return that peer instead so we never
 * trigger OAuth login prompts in non-interactive contexts.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.isInteractive] - Override TTY detection. When
 *   undefined, falls back to `process.stdin.isTTY`.
 * @returns {{
 *   provider: string,
 *   account: string|null,
 *   connection: { baseUrl: string, token: string, model: string }|null,
 *   reason: string,
 *   autoPromoted: boolean,
 * }|null} Returns null when no state file exists AND auto-promote is
 *   not applicable (interactive primary).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadFailoverConfig } from './monitor.js';
import { buildCustomPeers, getBestProviderOrNull } from './pool.js';

const STATE_FILE = join(homedir(), '.claude-nonstop', 'state', 'active.json');
const CONFIG_PATH = join(homedir(), '.claude-nonstop', 'failover.json');

/**
 * Resolve the runtime provider state for the next `claude` invocation.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.isInteractive]
 * @returns {Promise<{
 *   provider: string,
 *   account: string|null,
 *   connection: { baseUrl: string, token: string, model: string }|null,
 *   reason: string,
 *   autoPromoted: boolean,
 * }>}
 */
export async function resolveProvider(opts = {}) {
  const isInteractive = opts.isInteractive ?? Boolean(process.stdin?.isTTY);

  // Always read the latest state file first.
  const state = readStateFile();
  const provider = state?.provider ?? 'primary';

  // Non-TTY auto-promote: when invoked from a piped context, never start
  // OAuth login. If the monitor hasn't already switched to a custom
  // endpoint, find the first healthy peer in failover.json and use it.
  if (!isInteractive && provider === 'primary') {
    const promoted = await pickFirstHealthyPeer();
    if (promoted) {
      return {
        provider: promoted.name(),
        account: null,
        connection: promoted.getConnectionInfo(),
        reason: 'non_tty_auto_promote',
        autoPromoted: true,
      };
    }
  }

  if (!state) {
    // No state yet — return primary. Non-interactive callers without a
    // peer config will need to fall back to OAuth (which may prompt).
    return {
      provider: 'primary',
      account: null,
      connection: null,
      reason: 'no_state_file',
      autoPromoted: false,
    };
  }

  return {
    provider,
    account: state.account ?? null,
    connection: state.connection ?? null,
    reason: state.reason ?? 'from_state',
    autoPromoted: false,
  };
}

function readStateFile() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

async function pickFirstHealthyPeer() {
  const cfg = existsSync(CONFIG_PATH)
    ? loadFailoverConfig(CONFIG_PATH)
    : null;
  if (!cfg) return null;
  const peers = buildCustomPeers(cfg);
  if (peers.length === 0) return null;
  const { pickBestPeer } = await import('./pool.js');
  return pickBestPeer(peers, cfg.thresholds);
}

export { STATE_FILE };