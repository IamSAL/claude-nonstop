#!/usr/bin/env node
/**
 * claude-nonstop failover subcommand.
 *
 *   failover start                Start background monitor (writes state file).
 *   failover stop                 Stop background monitor (best-effort: pid file).
 *   failover status               Print current state + last reading.
 *   failover check                Run one check synchronously, print decision.
 *   failover dry-run              Print what would happen, change nothing.
 *
 * No state file mutation in dry-run mode.
 *
 * Backwards compatible with v0.2.0 config (single `fallback` entry, keys
 * `switch_to_fallback_at` / `switch_back_at`).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { CustomEndpointProvider } from './provider.js';
import { buildCustomPeers, getBestProviderOrNull } from './pool.js';
import { readCompatTokenFromUnit } from './cli_helpers.js';
import {
  FailoverMonitor,
  loadFailoverConfig,
  loadActiveState,
  STATE_FILE,
  LOG_FILE,
} from './monitor.js';

const CONFIG_PATH = join(homedir(), '.claude-nonstop', 'failover.json');
const PID_FILE = join(homedir(), '.claude-nonstop', 'state', 'failover.pid');

/**
 * Backwards-compat shim: build providers for callers that still expect the
 * `{ fallback }` shape from v0.2.0.
 */
function buildProviders(cfg) {
  // pool.js does the full normalization (legacy fallback → peer). This helper
  // exists only for callers that want a single `fallback` CompatProvider.
  if (cfg.fallback?.kind !== 'custom_endpoint' && cfg.fallback?.kind !== 'anthropic_compat') {
    return { fallback: null };
  }
  const envVar = cfg.fallback.authTokenEnv ?? 'ANTHROPIC_AUTH_TOKEN';
  const token = process.env[envVar] || readCompatTokenFromUnit();
  if (!token) return { fallback: null };
  const fallback = new CustomEndpointProvider({
    name: '_fallback',
    baseUrl: cfg.fallback.baseUrl,
    token,
    model: cfg.fallback.model ?? 'auto',
    thresholds: cfg.fallback.thresholds ?? null,
  });
  return { fallback };
}

function cmdStatus() {
  const cfg = loadFailoverConfig(CONFIG_PATH);
  const state = loadActiveState();
  console.log('failover config:', CONFIG_PATH);
  console.log('thresholds:', JSON.stringify(cfg.thresholds));
  const peers = buildCustomPeers(cfg);
  if (peers.length > 0) {
    console.log('peers:', peers.map((p) => {
      const t = p.thresholdOverrides();
      return `${p.name()}@${p.getConnectionInfo().baseUrl}${t ? ` (${JSON.stringify(t)})` : ''}`;
    }).join(', '));
  }
  if (!state) {
    console.log('no active state yet (monitor not running or never ticked)');
    return;
  }
  console.log('active state:');
  console.log(JSON.stringify(state, null, 2));
  console.log('log:', LOG_FILE);
}

async function cmdCheck() {
  const cfg = loadFailoverConfig(CONFIG_PATH);
  const peers = buildCustomPeers(cfg);
  if (peers.length === 0) {
    console.error('failover not configured (need fallback or peers in failover.json)');
    process.exit(2);
  }
  const monitor = new FailoverMonitor({
    thresholds: cfg.thresholds,
    cfg,
    log: (line) => console.log(line),
  });
  const state = await monitor.tick();
  console.log(JSON.stringify(state, null, 2));
}

async function cmdDryRun() {
  const cfg = loadFailoverConfig(CONFIG_PATH);
  const peers = buildCustomPeers(cfg);
  if (peers.length === 0) {
    console.error('failover not configured (need fallback or peers in failover.json)');
    process.exit(2);
  }
  const poolResult = await getBestProviderOrNull(cfg.thresholds, cfg);
  const current = existsSync(STATE_FILE)
    ? (JSON.parse(readFileSync(STATE_FILE, 'utf-8')).provider ?? 'primary')
    : 'primary';
  const { decide } = await import('./monitor.js');
  const decision = decide(current, poolResult, cfg.thresholds);
  const out = {
    mode: 'dry-run',
    current,
    pool: poolResult.all,
    best_oauth: poolResult.best ? {
      name: poolResult.best.provider.name(),
      reading: poolResult.best.reading,
    } : null,
    best_peer: poolResult.bestPeer ? poolResult.bestPeer.name() : null,
    would_switch: !!decision,
    decision,
    thresholds: cfg.thresholds,
    peers: peers.map((p) => ({
      name: p.name(),
      baseUrl: p.getConnectionInfo().baseUrl,
      thresholds: p.thresholdOverrides(),
    })),
  };
  console.log(JSON.stringify(out, null, 2));
}

function cmdStart() {
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (pid && processExists(pid)) {
      console.log(`failover monitor already running (pid ${pid})`);
      return;
    }
  }
  mkdirSync(join(homedir(), '.claude-nonstop', 'state'), { recursive: true });
  const child = spawn(process.execPath, [process.argv[1], '_daemon'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  console.log(`failover monitor started (pid ${child.pid}); log=${LOG_FILE}`);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cmdStop() {
  if (!existsSync(PID_FILE)) {
    console.log('no pid file; monitor not running');
    return;
  }
  const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
  if (pid && processExists(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`stopped failover monitor (pid ${pid})`);
    } catch (err) {
      console.log(`failed to stop pid ${pid}: ${err.message}`);
    }
  }
  try { writeFileSync(PID_FILE, ''); } catch {}
}

async function cmdDaemon() {
  const cfg = loadFailoverConfig(CONFIG_PATH);
  const peers = buildCustomPeers(cfg);
  if (peers.length === 0) {
    console.error('failover misconfigured (need fallback or peers); exiting');
    process.exit(2);
  }
  const monitor = new FailoverMonitor({ thresholds: cfg.thresholds, cfg });
  monitor.start();
  const shutdown = () => monitor.stop();
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  setInterval(() => {}, 60_000);
}

async function main() {
  const sub = process.argv[2];
  switch (sub) {
    case 'status': return cmdStatus();
    case 'check':  return cmdCheck();
    case 'dry-run': case 'dryrun': return cmdDryRun();
    case 'start':  return cmdStart();
    case 'stop':   return cmdStop();
    case '_daemon': return cmdDaemon();
    default:
      console.error('Usage: claude-nonstop failover {status|check|dry-run|start|stop}');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('failover error:', err.stack ?? err.message);
  process.exit(1);
});