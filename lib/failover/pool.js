/**
 * Unified provider pool — OAuth accounts + custom endpoint peers.
 *
 * The pool fetches utilization for all registered OAuth accounts in parallel
 * and returns the best healthy one (lowest effective utilization below
 * threshold). When all OAuth accounts are above threshold, the pool falls
 * back to the first healthy custom endpoint peer, ordered by per-peer
 * switch_at ascending (the peer that activates at the lowest OAuth
 * utilization takes priority).
 *
 * Each account (OAuth or custom) can carry per-account threshold overrides:
 *   { switch_at: number, switch_back_at: number }
 *
 * Legacy single-fallback configs (a single `fallback` entry with no `peers`
 * array) are transparently promoted to the peers array so all code paths
 * converge on the same multi-peer logic.
 */

import { OAuthProvider, CustomEndpointProvider } from './provider.js';
import { readCredentials } from '../keychain.js';
import { loadConfig } from '../config.js';
import { readCompatTokenFromUnit, readTokenFromFile } from './cli_helpers.js';

function resolveToken(configDir) {
  try {
    const creds = readCredentials(configDir);
    return creds?.token ?? null;
  } catch {
    return null;
  }
}

/**
 * Build OAuthProvider instances from all registered claude-nonstop accounts.
 *
 * Per-account thresholds are read from the account's entry in config.json
 * (set via `claude-nonstop set-threshold <name> <switch_at> <switch_back_at>`
 * or by editing config.json directly).
 *
 * @returns {OAuthProvider[]}
 */
export function buildAllOAuthProviders() {
  const accounts = loadConfig().accounts ?? [];
  return accounts.map((a) => new OAuthProvider({
    name: a.name,
    configDir: a.configDir,
    getToken: resolveToken,
    thresholds: a.thresholds ?? null,
  }));
}

/**
 * Resolve the API token for a custom endpoint peer entry.
 *
 * Resolution order:
 *   1. Literal `authToken` in config (for quick testing).
 *   2. `authTokenFile` — read from a file (systemd-creds, Docker secrets).
 *   3. `authTokenEnv` environment variable (default: ANTHROPIC_AUTH_TOKEN).
 *   4. Systemd unit file fallback (claude-failover.service).
 *
 * @param {object} peerCfg
 * @returns {string}
 */
function resolveCustomToken(peerCfg) {
  if (peerCfg.authToken) return peerCfg.authToken;
  if (peerCfg.authTokenFile) {
    const fromFile = readTokenFromFile(peerCfg.authTokenFile);
    if (fromFile) return fromFile;
  }
  const envVar = peerCfg.authTokenEnv ?? 'ANTHROPIC_AUTH_TOKEN';
  return process.env[envVar] ?? readCompatTokenFromUnit() ?? '';
}

/**
 * Build CustomEndpointProvider instances from the `peers` array in failover.json.
 *
 * Each peer entry:
 *   {
 *     name: string,             // required — used as custom:<name>
 *     kind: "custom_endpoint",  // required (or "anthropic_compat" for legacy)
 *     baseUrl: string,          // required
 *     authTokenEnv?: string,    // env var (default: ANTHROPIC_AUTH_TOKEN)
 *     authToken?: string,       // literal token
 *     authTokenFile?: string,   // file path (systemd-creds / Docker secrets)
 *     model?: string,           // default: "auto"
 *     thresholds?: {
 *       switch_at?: number,
 *       switch_back_at?: number,
 *     }
 *   }
 *
 * @param {object} cfg - Full failover config
 * @returns {CustomEndpointProvider[]}
 */
export function buildCustomPeers(cfg) {
  const peers = normalizePeers(cfg);
  return peers
    .filter((p) => p.name && p.baseUrl)
    .map((p) => new CustomEndpointProvider({
      name: p.name,
      baseUrl: p.baseUrl,
      token: resolveCustomToken(p),
      model: p.model ?? 'auto',
      thresholds: p.thresholds ?? null,
    }));
}

/**
 * Merge the legacy single `fallback` entry into the peers array if present.
 * Returns a unified peers list. Does NOT mutate the original config.
 */
function normalizePeers(cfg) {
  const peers = [...(Array.isArray(cfg.peers) ? cfg.peers : [])];
  // Promote legacy fallback to a peer named "_fallback" if not already in peers.
  if (cfg.fallback?.baseUrl && !peers.some((p) => p.name === '_fallback')) {
    peers.unshift({
      name: '_fallback',
      kind: cfg.fallback.kind ?? 'custom_endpoint',
      baseUrl: cfg.fallback.baseUrl,
      authTokenEnv: cfg.fallback.authTokenEnv,
      authToken: cfg.fallback.authToken,
      authTokenFile: cfg.fallback.authTokenFile,
      model: cfg.fallback.model,
      thresholds: cfg.fallback.thresholds ?? null,
    });
  }
  return peers;
}

/**
 * Read all account utilizations in parallel.
 */
export async function readAllUtilizations(providers) {
  return Promise.all(
    providers.map(async (provider) => {
      const reading = await provider.getUtilization();
      return { provider, reading };
    })
  );
}

/**
 * Pick the best primary OAuth account below threshold.
 *
 * Uses per-account threshold overrides when set; falls back to global.
 *
 * @param {Array<{ provider: OAuthProvider, reading }>} readings
 * @param {{ switch_at: number }} globalThresholds
 * @returns {{ provider, reading } | null}
 */
export function pickBestOAuth(readings, globalThresholds) {
  const scored = readings.map((r) => {
    let score;
    if (r.reading.error) {
      score = 100;
    } else if (r.reading.percent == null) {
      score = -1; // unknown — prefer over known-exhausted
    } else {
      score = r.reading.percent;
    }
    return { ...r, score };
  });

  scored.sort((a, b) => a.score - b.score);

  const best = scored[0];
  const threshold = best.provider.thresholdOverrides()?.switch_at
    ?? globalThresholds.switch_at;

  if (best.score >= threshold) return null;
  return { provider: best.provider, reading: best.reading };
}

/**
 * Pick the best healthy custom endpoint peer.
 *
 * Peers are ordered by their per-account `switch_at` ascending — the peer
 * that activates at the lowest OAuth utilization takes priority. Among peers
 * at the same threshold, the one listed first in config wins.
 *
 * @param {CustomEndpointProvider[]} peers
 * @param {{ switch_at: number }} globalThresholds
 * @returns {Promise<CustomEndpointProvider | null>}
 */
export async function pickBestPeer(peers, globalThresholds) {
  if (!peers || peers.length === 0) return null;

  const sorted = [...peers].sort((a, b) => {
    const aAt = a.thresholdOverrides()?.switch_at ?? globalThresholds.switch_at;
    const bAt = b.thresholdOverrides()?.switch_at ?? globalThresholds.switch_at;
    return aAt - bAt;
  });

  for (const peer of sorted) {
    if (await peer.isHealthy()) return peer;
  }
  return null;
}

/**
 * Merged pool lookup: OAuth accounts + custom endpoint peers.
 *
 * Returns the best OAuth provider if any are below threshold, or else the
 * first healthy custom endpoint peer.
 *
 * @param {{ switch_at: number, switch_back_at: number }} thresholds
 * @param {object} [cfg] - Full failover config (for peers)
 * @returns {Promise<{
 *   best: { provider, reading } | null,
 *   bestPeer: CustomEndpointProvider | null,
 *   all: Array<{ name, percent, error, isPeer? }>
 * }>}
 */
export async function getBestProviderOrNull(thresholds, cfg) {
  const oauthProviders = buildAllOAuthProviders();
  const peers = cfg ? buildCustomPeers(cfg) : [];

  const readings = oauthProviders.length > 0
    ? await readAllUtilizations(oauthProviders)
    : [];

  const bestOAuth = readings.length > 0
    ? pickBestOAuth(readings, thresholds)
    : null;

  // Only evaluate peers when OAuth is exhausted (or missing).
  const bestPeer = bestOAuth ? null : await pickBestPeer(peers, thresholds);

  // Probe peer health in parallel for the `all` summary so `failover status`,
  // `dry-run`, and the monitor's persisted `pool` block reflect real reachability
  // rather than the previous hardcoded {percent:0, error:null, isPeer:true}.
  const peerHealth = await Promise.all(
    peers.map(async (p) => {
      try {
        const healthy = await p.isHealthy();
        return { provider: p, healthy };
      } catch {
        return { provider: p, healthy: false };
      }
    })
  );

  const allSummary = [
    ...readings.map((r) => ({
      name: r.provider.name(),
      percent: r.reading.percent,
      error: r.reading.error,
    })),
    ...peerHealth.map(({ provider, healthy }) => ({
      name: provider.name(),
      percent: 0,
      error: healthy ? null : 'unhealthy',
      isPeer: true,
      healthy,
    })),
  ];

  return { best: bestOAuth, bestPeer, all: allSummary };
}
