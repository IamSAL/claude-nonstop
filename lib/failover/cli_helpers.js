/**
 * Shared helpers used by failover submodules.
 * Kept here to avoid circular imports between cli.js, pool.js, and monitor.js.
 */

import { readFileSync } from 'node:fs';

/**
 * Read the ANTHROPIC_AUTH_TOKEN from the systemd service unit file.
 * Useful when the env var is not exported to the current process but is
 * declared in the service unit's Environment= stanza.
 *
 * @returns {string|null}
 */
export function readCompatTokenFromUnit() {
  try {
    const unit = readFileSync('/etc/systemd/system/claude-failover.service', 'utf-8');
    const m = unit.match(/^Environment=ANTHROPIC_AUTH_TOKEN=(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  return null;
}

/**
 * Read a secret from an authTokenFile path (systemd-creds, Docker secrets, etc.).
 *
 * @param {string} filePath
 * @returns {string|null}
 */
export function readTokenFromFile(filePath) {
  if (!filePath) return null;
  try {
    return readFileSync(filePath, 'utf-8').trim() || null;
  } catch {}
  return null;
}
