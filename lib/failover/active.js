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

  // Hydrate the state file's token-free connection with the live token from the
  // configured source (authTokenEnv / authTokenFile / unit file). The state
  // file deliberately does NOT carry the bearer token (AGE-71) — re-resolve it
  // here at spawn time so the runner can set ANTHROPIC_AUTH_TOKEN.
  let connection = null;
  if (state.connection?.peer) {
    const live = await hydratePeerConnection(state.connection.peer);
    if (live) {
      connection = {
        baseUrl: state.connection.baseUrl ?? live.baseUrl,
        token: live.token,
        model: state.connection.model ?? live.model,
      };
    } else {
      // Peer no longer configured — fall back to a token-free projection so
      // the runner at least surfaces the right baseUrl/model (token will be
      // empty and the spawn will fail loudly rather than silently).
      connection = {
        baseUrl: state.connection.baseUrl ?? null,
        token: null,
        model: state.connection.model ?? null,
      };
    }
  } else if (state.connection?.baseUrl) {
    // Legacy state file written before AGE-71 — hydrate by config if possible,
    // otherwise return token-less.
    connection = { baseUrl: state.connection.baseUrl, token: null, model: state.connection.model ?? null };
  }

  return {
    provider,
    account: state.account ?? null,
    connection,
    reason: state.reason ?? 'from_state',
    autoPromoted: false,
  };
}

async function hydratePeerConnection(peerName) {
  const cfg = existsSync(CONFIG_PATH)
    ? loadFailoverConfig(CONFIG_PATH)
    : null;
  if (!cfg) return null;
  const peers = buildCustomPeers(cfg);
  const peer = peers.find((p) => p._name === peerName);
  if (!peer) return null;
  const info = peer.getConnectionInfo();
  return { baseUrl: info.baseUrl, token: info.token, model: info.model };
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