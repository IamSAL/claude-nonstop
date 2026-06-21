/**
 * Process runner — spawns Claude Code, monitors output for rate limits,
 * and automatically switches accounts with session migration.
 *
 * Flow:
 * 1. Spawn `claude` with CLAUDE_CONFIG_DIR pointing to selected account
 * 2. Pipe stdout/stderr through to the user's terminal (real-time pass-through)
 * 3. Simultaneously scan output for rate limit patterns
 * 4. On rate limit detection:
 *    a. Kill the paused Claude process
 *    b. Find the active session file
 *    c. Migrate session to the next best account's config dir
 *    d. Resume with `claude --resume <sessionId>` using the new account
 */

import * as pty from 'node-pty';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { readCredentials } from './keychain.js';
import { checkAllUsage } from './usage.js';
import { pickBestAccount, effectiveUtilization, pickPreemptAccount, PREEMPT_THRESHOLD } from './scorer.js';
import { findLatestSession, migrateSession } from './session.js';
import { reauthExpiredAccounts } from './reauth.js';
import { CONFIG_DIR } from './config.js';
import { getCurrentTmuxSession } from './tmux.js';
import { resolveProvider } from './failover/active.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_NOTIFY_PATH = path.resolve(__dirname, '..', 'remote', 'hook-notify.cjs');

/**
 * Rate limit detection pattern.
 * Claude Code outputs either:
 *   "Limit reached · resets Dec 17 at 6am (Europe/Oslo)"
 *   "You've hit your limit · resets 8am (America/Los_Angeles)"
 */
const RATE_LIMIT_PATTERN = /(?:Limit reached|You've hit your limit)\s*[·•]\s*resets\s+(.+?)(?:\s*$|\n)/im;

/** Maximum output buffer size before trimming (bytes). */
const OUTPUT_BUFFER_MAX = 4000;
/** Buffer trim target (bytes). */
const OUTPUT_BUFFER_TRIM = 2000;
/** Maximum number of account swaps before giving up. */
const MAX_SWAPS_DEFAULT = 5;
/** Message sent to auto-continue after rate-limit account switch. */
const RATE_LIMIT_CONTINUE_MSG = 'Continue.';
/** Time to wait before SIGKILL after SIGTERM (ms). */
const KILL_ESCALATION_DELAY = 3000;
/** Utilization threshold (%) at which all accounts are considered near-exhausted. */
const EXHAUSTION_THRESHOLD = 99;
/** Maximum sleep duration when waiting for a rate limit reset (6 hours). */
const MAX_SLEEP_MS = 6 * 60 * 60 * 1000;
/**
 * How often the background watcher re-checks usage while parked on a
 * lower-priority account, to see if a higher-priority account has freed up
 * (default 5 minutes). Set CLAUDE_NONSTOP_PREEMPT_INTERVAL_MS=0 to disable.
 */
const PREEMPT_POLL_INTERVAL_MS = 5 * 60 * 1000;

// ─── ANSI Stripping ────────────────────────────────────────────────────────

/** Strip ANSI escape codes (colors, cursor, etc.) from PTY output. */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/**
 * Spawn hook-notify.cjs fire-and-forget with data on stdin.
 */
function spawnHookNotify(type, data) {
  const child = execFile('node', [HOOK_NOTIFY_PATH, type], {
    timeout: 15_000,
    stdio: ['pipe', 'ignore', 'ignore'],
  }, () => {});
  child.stdin.write(JSON.stringify(data));
  child.stdin.end();
  child.unref();
}

/**
 * Resolve the background-watcher poll interval (ms) from the environment,
 * falling back to the default. A value of 0 (or negative/invalid) disables
 * the watcher entirely.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {number} interval in ms, or 0 if disabled
 */
function resolvePreemptIntervalMs(env = process.env) {
  const raw = env.CLAUDE_NONSTOP_PREEMPT_INTERVAL_MS;
  if (raw === undefined || raw === '') return PREEMPT_POLL_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

/**
 * Resolve the "freed up" utilization threshold (%) from the environment,
 * falling back to the scorer default.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {number} threshold percent
 */
function resolvePreemptThreshold(env = process.env) {
  const raw = env.CLAUDE_NONSTOP_PREEMPT_THRESHOLD;
  if (raw === undefined || raw === '') return PREEMPT_THRESHOLD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return PREEMPT_THRESHOLD;
  return n;
}

/**
 * Find the earliest reset time across all non-excluded accounts.
 *
 * @param {Array<{name: string, usage: object}>} accounts
 * @param {string} [excludeName] - Account name to skip
 * @returns {number} Milliseconds until earliest reset (0 if no reset info available)
 */
function findEarliestReset(accounts, excludeName) {
  const now = Date.now();
  let earliest = Infinity;

  for (const a of accounts) {
    if (a.name === excludeName) continue;
    if (!a.usage) continue;

    for (const ts of [a.usage.sessionResetsAt, a.usage.weeklyResetsAt]) {
      if (!ts) continue;
      const resetMs = new Date(ts).getTime();
      if (isNaN(resetMs)) continue;
      if (resetMs > now && resetMs < earliest) {
        earliest = resetMs;
      }
    }
  }

  if (earliest === Infinity) return 0;
  return earliest - now;
}

/**
 * Format a duration in ms to a human-readable string like "2h 15m".
 */
function formatDuration(ms) {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Sleep for the given number of milliseconds.
 * Interruptible: SIGINT or SIGTERM will resolve the sleep early.
 *
 * @param {number} ms
 * @returns {Promise<{ interrupted: boolean }>}
 */
function sleep(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      cleanup();
      resolve({ interrupted: false });
    }, ms);

    function onSignal() {
      cleanup();
      resolve({ interrupted: true });
    }

    function cleanup() {
      clearTimeout(timer);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

/**
 * Deactivate stale channel-map entries for a tmux session.
 * Called at startup so that reuseChannelForTmuxSession only matches
 * entries created during the current invocation (e.g., /clear or rate-limit restart),
 * not leftover entries from a previous run.
 *
 * @param {string} tmuxSessionName - The tmux session name to match
 * @param {string} [channelMapPath] - Path to channel-map.json (default: CONFIG_DIR/data/channel-map.json)
 */
function deactivateStaleChannels(tmuxSessionName, channelMapPath) {
  if (!channelMapPath) {
    channelMapPath = path.join(CONFIG_DIR(), 'data', 'channel-map.json');
  }
  try {
    if (!fs.existsSync(channelMapPath)) return;
    const raw = fs.readFileSync(channelMapPath, 'utf8');
    if (!raw.trim()) return;
    const map = JSON.parse(raw);

    let changed = false;
    for (const entry of Object.values(map)) {
      if (entry.tmuxSession === tmuxSessionName && entry.active) {
        entry.active = false;
        changed = true;
      }
    }

    if (changed) {
      const dir = path.dirname(channelMapPath);
      const tmpFile = path.join(dir, `.channel-map.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tmpFile, JSON.stringify(map, null, 2), { mode: 0o600 });
      fs.renameSync(tmpFile, channelMapPath);
    }
  } catch {
    // Non-fatal — channel reuse is a convenience, not critical
  }
}

/**
 * Run Claude Code with automatic account switching.
 *
 * @param {string[]} claudeArgs - Arguments to pass to `claude`
 * @param {{ name: string, configDir: string }} selectedAccount - Account to use
 * @param {Array<{ name: string, configDir: string }>} allAccounts - All registered accounts
 * @param {{ maxSwaps?: number, remoteAccess?: boolean }} options - Runner options
 */
export async function run(claudeArgs, selectedAccount, allAccounts, options = {}) {
  // Scale swap budget with account count — with N accounts, you may need
  // N-1 swaps to try them all before exhaustion triggers the sleep mechanism.
  // The * 2 multiplier allows for accounts recovering mid-session (5-hour resets).
  const maxSwaps = options.maxSwaps ?? Math.max(MAX_SWAPS_DEFAULT, allAccounts.length * 2);
  const remoteAccess = options.remoteAccess ?? false;
  let currentAccount = selectedAccount;
  let swapCount = 0;
  let sessionId = extractResumeSessionId(claudeArgs);

  // Deactivate stale channel entries from previous invocations so that
  // reuseChannelForTmuxSession only matches entries from this run
  // (i.e., /clear or rate-limit restarts within the same tmux session).
  if (remoteAccess) {
    deactivateStaleChannels(getCurrentTmuxSession());
  }

  while (swapCount <= maxSwaps) {
    const result = await runOnce(claudeArgs, currentAccount, sessionId, {
      remoteAccess,
      allAccounts,
    });

    // Background watcher preempted: a higher-priority account freed up while we
    // were parked on a lower-priority one. Treat like a swap, but force priority
    // selection and don't charge it against the swap budget (it's a recovery,
    // not a rate-limit retreat).
    if (result.preemptDetected && result.preemptTo) {
      const cwd = process.cwd();
      const session = findLatestSession(currentAccount.configDir, cwd);
      const nextAccount = result.preemptTo;
      console.error(`\n[claude-nonstop] Switching to "${nextAccount.name}" (${result.preemptReason})`);

      if (remoteAccess) {
        spawnHookNotify('account-switch', {
          session_id: sessionId || null,
          cwd,
          from_account: currentAccount.name,
          to_account: nextAccount.name,
          reason: result.preemptReason,
          swap_count: swapCount,
          max_swaps: maxSwaps,
        });
      }

      if (session) {
        const migration = migrateSession(currentAccount.configDir, nextAccount.configDir, cwd, session.sessionId);
        if (migration.success) {
          sessionId = session.sessionId;
          console.error(`[claude-nonstop] Session ${sessionId} migrated successfully`);
        } else {
          console.error(`[claude-nonstop] Session migration failed: ${migration.error}`);
          console.error('[claude-nonstop] Starting fresh session on new account');
          sessionId = null;
        }
      } else {
        sessionId = null;
      }

      if (sessionId) {
        claudeArgs = buildResumeArgs(claudeArgs, sessionId, RATE_LIMIT_CONTINUE_MSG);
      }

      currentAccount = nextAccount;
      continue;
    }

    if (result.exitCode !== null && !result.rateLimitDetected) {
      // Normal exit — propagate the exit code
      process.exitCode = result.exitCode;
      return;
    }

    if (!result.rateLimitDetected) {
      // Process ended without rate limit (e.g., signal)
      process.exitCode = result.exitCode ?? 1;
      return;
    }

    // Rate limit detected — attempt swap
    swapCount++;
    console.error(`\n[claude-nonstop] Rate limit detected on "${currentAccount.name}" (swap ${swapCount}/${maxSwaps})`);

    if (swapCount > maxSwaps) {
      console.error('[claude-nonstop] Maximum swap attempts reached. All accounts may be rate-limited.');
      process.exitCode = 1;
      return;
    }

    // Find the session to migrate
    const cwd = process.cwd();
    const session = result.sessionId
      ? { sessionId: result.sessionId }
      : findLatestSession(currentAccount.configDir, cwd);

    if (!session) {
      console.error('[claude-nonstop] Could not find session to migrate. Starting fresh on new account.');
    }

    // Pick the next best account
    const accountsWithTokens = allAccounts.map(a => ({
      ...a,
      token: readCredentials(a.configDir).token,
    })).filter(a => a.token);

    let accountsWithUsage = await checkAllUsage(accountsWithTokens);
    const hasPriorities = accountsWithUsage.some(a => a.priority != null);
    let best = pickBestAccount(accountsWithUsage, currentAccount.name, { usePriority: hasPriorities });

    // If best candidate is near-exhausted, sleep until earliest reset instead of thrashing.
    // Include all accounts (even current) when finding reset times — after sleeping,
    // any account may have recovered, including the one that just hit the limit.
    //
    // TODO: For remote mode, consider an event-driven approach instead of blocking sleep:
    //   1. Notify Slack and save session state to disk
    //   2. Exit the runner cleanly
    //   3. Slack bot schedules a re-launch at the reset time (or user sends !resume)
    // This would free the tmux pane instead of holding it for hours.
    if (best && effectiveUtilization(best.account.usage) >= EXHAUSTION_THRESHOLD) {
      const sleepMs = findEarliestReset(accountsWithUsage);
      if (sleepMs > 0) {
        const clampedMs = Math.min(sleepMs, MAX_SLEEP_MS);
        const resetDate = new Date(Date.now() + clampedMs);
        console.error(`[claude-nonstop] All accounts near limit. Sleeping until ${resetDate.toLocaleTimeString()} (${formatDuration(clampedMs)})...`);

        if (remoteAccess) {
          spawnHookNotify('sleep-until-reset', {
            session_id: sessionId || null,
            cwd: process.cwd(),
            current_account: currentAccount.name,
            sleep_ms: clampedMs,
            reset_at: resetDate.toISOString(),
          });
        }

        const { interrupted } = await sleep(clampedMs);
        if (interrupted) {
          console.error('\n[claude-nonstop] Sleep interrupted by signal. Exiting.');
          process.exitCode = 130;
          return;
        }

        console.error('[claude-nonstop] Sleep complete. Re-checking account usage...');

        // Re-fetch usage after sleeping — any account may have recovered,
        // including the current one, so don't exclude it from the pick.
        const refreshedTokens = allAccounts.map(a => ({
          ...a,
          token: readCredentials(a.configDir).token,
        })).filter(a => a.token);
        accountsWithUsage = await checkAllUsage(refreshedTokens);
        best = pickBestAccount(accountsWithUsage, undefined, { usePriority: hasPriorities });

        if (remoteAccess) {
          spawnHookNotify('sleep-wake', {
            session_id: sessionId || null,
            cwd: process.cwd(),
            current_account: currentAccount.name,
            best_account: best?.account?.name || null,
          });
        }

        // Sleep-then-swap doesn't count against the swap budget — the sleep
        // itself is the mechanism to avoid thrashing, so this is a "free" swap.
        swapCount--;
      }
    }

    // If no accounts available, check if auth errors are the cause and attempt re-auth
    if (!best && !remoteAccess) {
      const authErrors = accountsWithUsage.filter(a =>
        a.name !== currentAccount.name && a.usage?.error === 'HTTP 401'
      );
      if (authErrors.length > 0) {
        console.error('[claude-nonstop] Some accounts have expired tokens. Attempting re-auth...');
        const refreshed = await reauthExpiredAccounts(authErrors);
        if (refreshed.length > 0) {
          // Re-read credentials and re-check usage
          const updatedAccounts = allAccounts.map(a => ({
            ...a,
            token: readCredentials(a.configDir).token,
          })).filter(a => a.token);
          accountsWithUsage = await checkAllUsage(updatedAccounts);
          best = pickBestAccount(accountsWithUsage, currentAccount.name, { usePriority: hasPriorities });
        }
      }
    }

    if (!best) {
      console.error('[claude-nonstop] No alternative accounts available.');
      process.exitCode = 1;
      return;
    }

    const nextAccount = best.account;
    console.error(`[claude-nonstop] Switching to "${nextAccount.name}" (${best.reason})`);

    // Notify Slack about account switch (fire-and-forget)
    if (remoteAccess) {
      spawnHookNotify('account-switch', {
        session_id: sessionId || null,
        cwd: process.cwd(),
        from_account: currentAccount.name,
        to_account: nextAccount.name,
        reason: best.reason,
        swap_count: swapCount,
        max_swaps: maxSwaps,
      });
    }

    // Migrate session if we have one
    if (session) {
      const migration = migrateSession(
        currentAccount.configDir,
        nextAccount.configDir,
        cwd,
        session.sessionId
      );

      if (migration.success) {
        sessionId = session.sessionId;
        console.error(`[claude-nonstop] Session ${sessionId} migrated successfully`);
      } else {
        console.error(`[claude-nonstop] Session migration failed: ${migration.error}`);
        console.error('[claude-nonstop] Starting fresh session on new account');
        sessionId = null;
      }
    } else {
      sessionId = null;
    }

    // Update args for resume if we have a session — include continuation
    // message so Claude picks up immediately instead of waiting for input
    if (sessionId) {
      claudeArgs = buildResumeArgs(claudeArgs, sessionId, RATE_LIMIT_CONTINUE_MSG);
    }

    currentAccount = nextAccount;
  }
}

/**
 * Run Claude once, monitoring for rate limits and (when a higher-priority
 * account can outrank the current one) running a background watcher that
 * preempts to that account once it frees up.
 *
 * @returns {Promise<{ exitCode: number|null, rateLimitDetected: boolean, resetTime: string|null, sessionId: string|null, preemptDetected: boolean, preemptTo: object|null, preemptReason: string|null }>}
 */
function runOnce(claudeArgs, account, existingSessionId, options = {}) {
  return new Promise(async (resolve) => {
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: account.configDir,
      FORCE_COLOR: '1',
    };

    // Strip CLAUDECODE so spawned claude works from inside a Claude Code session
    delete env.CLAUDECODE;

    if (options.remoteAccess) {
      env.CLAUDE_REMOTE_ACCESS = 'true';
    }

    // Apply failover-driven env vars (custom endpoint peers). This handles
    // both the monitor's choice and the non-TTY auto-promote path in one
    // place, so the spawned `claude` always sees the right ANTHROPIC_BASE_URL
    // and ANTHROPIC_AUTH_TOKEN regardless of how the decision was reached.
    try {
      const providerInfo = await resolveProvider({ isInteractive: Boolean(process.stdin?.isTTY) });
      if (providerInfo?.connection) {
        env.ANTHROPIC_BASE_URL = providerInfo.connection.baseUrl;
        env.ANTHROPIC_AUTH_TOKEN = providerInfo.connection.token;
        if (providerInfo.connection.model && providerInfo.connection.model !== 'auto') {
          env.ANTHROPIC_MODEL = providerInfo.connection.model;
        }
        // Force pure fallback behavior — don't let OAuth creds leak through.
        env.CLAUDE_CONFIG_DIR = '/dev/null';
        if (providerInfo.autoPromoted) {
          console.error(`[claude-nonstop] Auto-promoted to ${providerInfo.provider} (${providerInfo.reason})`);
        }
      }
    } catch {}

    const child = pty.spawn('claude', claudeArgs, {
      name: 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd: process.cwd(),
      env,
    });

    // Resize PTY when the real terminal resizes
    const onResize = () => {
      try { child.resize(process.stdout.columns, process.stdout.rows); } catch {}
    };
    process.stdout.on('resize', onResize);

    // Forward stdin to the PTY (resume in case it was paused by a previous runOnce)
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    const onStdinData = (data) => child.write(data);
    process.stdin.on('data', onStdinData);
    process.stdin.on('error', () => {});

    let rateLimitDetected = false;
    let resetTime = null;
    let outputBuffer = '';

    // Background watcher: while parked on a lower-priority account, periodically
    // check whether a higher-priority account has freed up and, if so, preempt
    // (kill child -> caller migrates session -> resumes on the better account).
    let preemptDetected = false;
    let preemptTo = null;
    let preemptReason = null;
    let watcherBusy = false;
    const allAccounts = options.allAccounts || [];
    const pollMs = resolvePreemptIntervalMs();
    const preemptThreshold = resolvePreemptThreshold();
    // Only worth polling when the current account isn't already top priority and
    // there's at least one account that could outrank it.
    const currentPriority = allAccounts.find(a => a.name === account.name)?.priority;
    const watcherEnabled = pollMs > 0
      && currentPriority != null
      && allAccounts.some(a => a.priority != null && a.priority < currentPriority);

    async function pollForHigherPriority() {
      if (watcherBusy || rateLimitDetected || preemptDetected) return;
      watcherBusy = true;
      try {
        const withTokens = allAccounts
          .map(a => ({ ...a, token: readCredentials(a.configDir).token }))
          .filter(a => a.token);
        const withUsage = await checkAllUsage(withTokens);
        if (rateLimitDetected || preemptDetected) return; // raced with another path
        const choice = pickPreemptAccount(withUsage, account.name, { threshold: preemptThreshold });
        if (choice) {
          preemptDetected = true;
          preemptTo = choice.account;
          preemptReason = choice.reason;
          child.kill('SIGTERM');
          setTimeout(() => {
            try { child.kill('SIGKILL'); } catch {}
          }, KILL_ESCALATION_DELAY);
        }
      } catch {
        // Usage check failed (network/keychain) — skip this tick, try again next.
      } finally {
        watcherBusy = false;
      }
    }

    const watcherTimer = watcherEnabled
      ? setInterval(pollForHigherPriority, pollMs)
      : null;
    if (watcherTimer && typeof watcherTimer.unref === 'function') watcherTimer.unref();

    child.onData((data) => {
      process.stdout.write(data);

      // Scan for rate limit patterns in rolling buffer
      outputBuffer += data;
      if (outputBuffer.length > OUTPUT_BUFFER_MAX) {
        outputBuffer = outputBuffer.slice(-OUTPUT_BUFFER_TRIM);
      }

      if (rateLimitDetected) return;

      // Primary pattern: "Limit reached · resets ..."
      // Strip ANSI codes before matching — FORCE_COLOR=1 means output has styling
      const match = RATE_LIMIT_PATTERN.exec(stripAnsi(outputBuffer));
      if (match) {
        rateLimitDetected = true;
        resetTime = match[1].trim();
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, KILL_ESCALATION_DELAY);
        return;
      }
    });

    // Forward signals to child
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const signalHandlers = {};
    let cleaned = false;

    function cleanup() {
      if (cleaned) return;
      cleaned = true;

      if (watcherTimer) clearInterval(watcherTimer);

      for (const sig of signals) {
        process.removeListener(sig, signalHandlers[sig]);
      }

      process.stdin.removeListener('data', onStdinData);
      process.stdin.pause();
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch {}
      }
      process.stdout.removeListener('resize', onResize);
    }

    for (const sig of signals) {
      const handler = () => {
        if (!rateLimitDetected && !preemptDetected) {
          try { child.kill(sig); } catch {}
        }
      };
      signalHandlers[sig] = handler;
      process.on(sig, handler);
    }

    // Single onExit handler: cleanup + resolve
    child.onExit(({ exitCode }) => {
      cleanup();

      resolve({
        exitCode: exitCode ?? null,
        rateLimitDetected,
        resetTime,
        sessionId: existingSessionId,
        preemptDetected,
        preemptTo,
        preemptReason,
      });
    });
  });
}

/**
 * Extract --resume session ID from claude args if present.
 */
function extractResumeSessionId(args) {
  const idx = args.indexOf('--resume');
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  // Also check -r shorthand
  const idxR = args.indexOf('-r');
  if (idxR !== -1 && idxR + 1 < args.length) {
    return args[idxR + 1];
  }
  return null;
}

/** Known Claude CLI flags that take a value argument. */
const FLAGS_WITH_VALUES = new Set([
  '--append-system-prompt', '--model', '-m',
  '--allowedTools', '--disallowedTools',
]);

/**
 * Build new claude args with --resume flag.
 * Replaces existing --resume if present, otherwise prepends it.
 *
 * When continueMessage is provided (rate-limit swap), strips positional args
 * (the original user prompt and any previous continue message) so Claude
 * receives only the continuation prompt and picks up where it left off.
 */
function buildResumeArgs(originalArgs, sessionId, continueMessage) {
  const args = [...originalArgs];

  // Remove existing --resume or -r flags
  for (const flag of ['--resume', '-r']) {
    const idx = args.indexOf(flag);
    if (idx !== -1) {
      args.splice(idx, 2); // Remove flag and its value
    }
  }

  if (continueMessage) {
    // Strip positional args — keep only flags and their values
    const flagsOnly = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('-')) {
        flagsOnly.push(args[i]);
        if (FLAGS_WITH_VALUES.has(args[i]) && i + 1 < args.length) {
          flagsOnly.push(args[++i]);
        }
      }
    }
    flagsOnly.unshift('--resume', sessionId);
    flagsOnly.push(continueMessage);
    return flagsOnly;
  }

  // Prepend --resume
  args.unshift('--resume', sessionId);
  return args;
}

export {
  stripAnsi, extractResumeSessionId, buildResumeArgs, RATE_LIMIT_PATTERN,
  RATE_LIMIT_CONTINUE_MSG, FLAGS_WITH_VALUES,
  findEarliestReset, formatDuration, sleep, deactivateStaleChannels,
  EXHAUSTION_THRESHOLD, MAX_SLEEP_MS,
  resolvePreemptIntervalMs, resolvePreemptThreshold,
  PREEMPT_POLL_INTERVAL_MS,
};
