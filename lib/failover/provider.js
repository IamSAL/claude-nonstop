/**
 * Provider abstraction for the failover layer.
 *
 * Three concrete providers:
 *
 *   OAuthProvider         Primary tier. Reads utilization from the Anthropic
 *                         OAuth usage API. Backed by claude-nonstop's keychain
 *                         credential store (one OAuth token per configDir).
 *
 *   CustomEndpointProvider  An Anthropic-API-compatible endpoint identified by
 *                         (baseUrl + API key). Can be a single legacy
 *                         `fallback` OR one of many named `peers` in the pool.
 *                         Health checked via GET <baseUrl>/v1/models. Has no
 *                         Anthropic-side quota view, so utilization is always 0.
 *                         Carries optional per-account threshold overrides.
 *
 * Each provider exposes:
 *   name()              - Short identifier for logging / state file
 *   getUtilization()    - { percent: 0-100|null, error: string|null, ... }
 *   isHealthy()         - Boolean, true when a recent probe succeeded
 *   describe()          - Human-readable one-liner for logs
 *   thresholdOverrides()- { switch_at?, switch_back_at? } | null
 *   kind()              - "oauth" | "custom_endpoint"
 */

const FETCH_TIMEOUT_MS = 8_000;

function normalizePercent(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  if (value >= 0 && value <= 1) return Math.round(value * 100);
  return Math.round(value);
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── OAuth Provider ────────────────────────────────────────────────────────

export class OAuthProvider {
  /**
   * @param {{
   *   name: string,
   *   configDir: string,
   *   getToken: (configDir: string) => string|null,
   *   thresholds?: { switch_at?: number, switch_back_at?: number }
   * }} opts
   */
  constructor({ name, configDir, getToken, thresholds }) {
    this._name = name;
    this._configDir = configDir;
    this._getToken = getToken;
    this._thresholds = thresholds ?? null;
  }

  kind() { return 'oauth'; }

  name() { return `oauth:${this._name}`; }

  thresholdOverrides() { return this._thresholds; }

  async getUtilization() {
    const token = this._getToken(this._configDir);
    if (!token) return { percent: null, error: 'no_token' };

    try {
      const res = await fetchWithTimeout('https://api.anthropic.com/api/oauth/usage', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
      });
      if (res.status === 401 || res.status === 403) {
        return { percent: null, error: `auth_${res.status}` };
      }
      if (res.status === 429) {
        return { percent: 100, error: null, hint: 'usage_endpoint_429' };
      }
      if (!res.ok) {
        return { percent: null, error: `http_${res.status}` };
      }
      const data = await res.json();
      const session = data.five_hour?.utilization ?? data.five_hour_utilization ?? 0;
      const weekly = data.seven_day?.utilization ?? data.seven_day_utilization ?? 0;
      return {
        percent: Math.max(normalizePercent(session), normalizePercent(weekly)),
        error: null,
        sessionResetsAt: data.five_hour?.resets_at ?? data.five_hour_reset_at ?? null,
        weeklyResetsAt: data.seven_day?.resets_at ?? data.seven_day_reset_at ?? null,
      };
    } catch (err) {
      return { percent: null, error: err.name === 'AbortError' ? 'timeout' : err.message };
    }
  }

  async isHealthy() {
    const u = await this.getUtilization();
    return u.error == null && (u.percent == null || u.percent < 100);
  }

  describe(u) {
    const reading = u ?? null;
    const pct = reading?.percent == null ? '?' : `${reading.percent}%`;
    return `oauth:${this._name} util=${pct}${reading?.error ? ` err=${reading.error}` : ''}`;
  }
}

// ─── Custom Endpoint Provider ──────────────────────────────────────────────

export class CustomEndpointProvider {
  /**
   * @param {{
   *   name: string,
   *   baseUrl: string,
   *   token: string,
   *   model?: string,
   *   thresholds?: { switch_at?: number, switch_back_at?: number }
   * }} opts
   */
  constructor({ name, baseUrl, token, model, thresholds }) {
    this._name = name;
    this._baseUrl = baseUrl.replace(/\/+$/, '');
    this._token = token;
    this._model = model ?? 'auto';
    this._thresholds = thresholds ?? null;
    this._lastHealthAt = 0;
    this._lastHealthy = false;
  }

  kind() { return 'custom_endpoint'; }

  name() { return `custom:${this._name}`; }

  thresholdOverrides() { return this._thresholds; }

  /**
   * Custom endpoints have no Anthropic-side quota view.
   * Convention: 0% (unlimited from our perspective), with `unknown: true`.
   */
  async getUtilization() {
    return { percent: 0, error: null, unknown: true };
  }

  async isHealthy() {
    const now = Date.now();
    if (now - this._lastHealthAt < 30_000) return this._lastHealthy;
    this._lastHealthAt = now;
    try {
      const res = await fetchWithTimeout(`${this._baseUrl}/v1/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this._token}` },
      });
      this._lastHealthy = res.ok;
      return res.ok;
    } catch {
      this._lastHealthy = false;
      return false;
    }
  }

  describe() {
    return `custom:${this._name} model=${this._model} base=${this._baseUrl}`;
  }

  /** Expose connection details so the runner can set env vars. */
  getConnectionInfo() {
    return {
      baseUrl: this._baseUrl,
      token: this._token,
      model: this._model,
    };
  }
}
