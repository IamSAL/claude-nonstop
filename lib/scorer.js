/**
 * Account scoring and selection.
 *
 * Picks the best account based on usage — lowest effective utilization wins.
 * Effective utilization = max(sessionPercent, weeklyPercent) so we avoid
 * accounts that are near either limit.
 *
 * When usePriority is true, accounts with lower priority numbers are preferred
 * over accounts with lower utilization. Accounts at or above 98% utilization
 * are considered "near-exhausted" and skipped in favor of the next priority.
 */

const PRIORITY_THRESHOLD = 98;

/**
 * Short human-readable usage descriptor for log/reason strings. Spend-metered
 * accounts report their dollar utilization; window accounts report session/weekly.
 */
function describeUsage(usage) {
  if (usage?.meterType === 'spend') {
    return `spend: ${usage.spendPercent ?? 0}%`;
  }
  return `session: ${usage?.sessionPercent ?? 0}%, weekly: ${usage?.weeklyPercent ?? 0}%`;
}

/**
 * Pick the best account from a list of accounts with usage data.
 *
 * @param {Array<{name: string, configDir: string, token: string, usage: object, priority?: number}>} accounts
 * @param {string} [excludeName] - Account name to exclude (e.g., the one that just hit a limit)
 * @param {object} [options]
 * @param {boolean} [options.usePriority=false] - When true, prefer accounts by priority number
 * @returns {{ account: object, reason: string } | null}
 */
export function pickBestAccount(accounts, excludeName, options = {}) {
  const candidates = accounts.filter(a => {
    if (a.name === excludeName) return false;
    if (!a.token) return false;
    if (a.usage?.error) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  if (options.usePriority) {
    // Priority-aware sorting:
    // 1. Non-exhausted (< 98%) before exhausted (>= 98%)
    // 2. Within each group: lower priority number first (nulls last)
    // 3. Tiebreaker: lower utilization first
    candidates.sort((a, b) => {
      const aUtil = effectiveUtilization(a.usage);
      const bUtil = effectiveUtilization(b.usage);
      const aExhausted = aUtil >= PRIORITY_THRESHOLD;
      const bExhausted = bUtil >= PRIORITY_THRESHOLD;

      // Non-exhausted accounts always come first
      if (aExhausted !== bExhausted) return aExhausted ? 1 : -1;

      // Within same exhaustion group: sort by priority (lower = better, null = last)
      const aPri = a.priority ?? Infinity;
      const bPri = b.priority ?? Infinity;
      if (aPri !== bPri) return aPri - bPri;

      // Same priority: sort by utilization
      return aUtil - bUtil;
    });

    const best = candidates[0];
    const pri = best.priority != null ? `, priority: ${best.priority}` : '';

    return {
      account: best,
      reason: `priority selection (${describeUsage(best.usage)}${pri})`,
    };
  }

  // Default: sort by effective utilization (ascending — lowest usage first)
  candidates.sort((a, b) => {
    const aUtil = effectiveUtilization(a.usage);
    const bUtil = effectiveUtilization(b.usage);
    return aUtil - bUtil;
  });

  const best = candidates[0];

  return {
    account: best,
    reason: `lowest utilization (${describeUsage(best.usage)})`,
  };
}

/**
 * Pick the best account using priority hierarchy.
 * Convenience wrapper for `use --priority`.
 *
 * @param {Array} accounts - Accounts with usage data
 * @returns {{ account: object, reason: string } | null}
 */
export function pickByPriority(accounts) {
  return pickBestAccount(accounts, undefined, { usePriority: true });
}

/**
 * Calculate effective utilization — the highest of session, weekly, or spend.
 *
 * Spend-metered (Enterprise usage-based) accounts have null session/weekly
 * windows, so their utilization is driven by spendPercent. Folding it into the
 * same max() means an Enterprise account that is over its monthly dollar cap
 * (spendPercent >= 100) is treated as exhausted by every selection path —
 * routing, priority, and preemption — with no other changes needed.
 */
export function effectiveUtilization(usage) {
  if (!usage) return 100;
  return Math.max(usage.sessionPercent || 0, usage.weeklyPercent || 0, usage.spendPercent || 0);
}

/**
 * Default utilization (%) below which a higher-priority account is considered
 * "freed up" enough to preempt the current lower-priority account.
 * Kept below PRIORITY_THRESHOLD so we never swap back to an account that the
 * normal switch logic would immediately reject as near-exhausted.
 */
const PREEMPT_THRESHOLD = 90;

/**
 * Decide whether to preempt the current account in favor of a higher-priority
 * one that has freed up. Used by the background watcher so a last-resort account
 * (e.g. priority 4) is abandoned as soon as priorities 1–N recover.
 *
 * A swap is recommended only when some account with a STRICTLY lower priority
 * number than the current account has effective utilization below `threshold`.
 * Among qualifying accounts, the lowest priority number wins (utilization breaks
 * ties), matching pickByPriority semantics.
 *
 * Returns null when no swap is warranted: current account has no priority, is
 * already top priority, has a usage error, or no higher-priority account is
 * sufficiently free.
 *
 * @param {Array<{name, usage, token?, priority?}>} accounts - accounts with usage
 * @param {string} currentName - the account currently in use
 * @param {object} [options]
 * @param {number} [options.threshold=PREEMPT_THRESHOLD] - free-enough cutoff (%)
 * @returns {{ account: object, reason: string } | null}
 */
export function pickPreemptAccount(accounts, currentName, options = {}) {
  const threshold = options.threshold ?? PREEMPT_THRESHOLD;
  const current = accounts.find(a => a.name === currentName);
  // Only preempt away from an account that has a priority. A null/undefined
  // priority is treated as lowest rank, but nothing can outrank "lowest" in a
  // way that matters here, so there is no higher-priority target to jump to.
  if (!current || current.priority == null) return null;

  const candidates = accounts.filter(a => {
    if (a.name === currentName) return false;
    if (!a.token) return false;
    if (a.usage?.error) return false;
    if (a.priority == null) return false;
    if (a.priority >= current.priority) return false; // must outrank current
    return effectiveUtilization(a.usage) < threshold;
  });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return effectiveUtilization(a.usage) - effectiveUtilization(b.usage);
  });

  const best = candidates[0];
  return {
    account: best,
    reason: `higher-priority account freed up (now priority ${best.priority}, was on ${currentName} priority ${current.priority}; ${describeUsage(best.usage)})`,
  };
}

export { PRIORITY_THRESHOLD, PREEMPT_THRESHOLD };
