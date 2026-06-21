/**
 * Temp HOME helpers for tests that need to redirect ~/.claude-nonstop writes.
 *
 * The v0.4.0 main branch doesn't ship a tmpHome helper yet — this file adds
 * one for the failover tests.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

let savedHome = null;
let tmpHomeDir = null;

export function tmpHome(prefix = 'cns-test-home-') {
  if (savedHome) return tmpHomeDir;
  savedHome = process.env.HOME ?? homedir();
  tmpHomeDir = mkdtempSync(join(tmpdir(), prefix));
  process.env.HOME = tmpHomeDir;
  return tmpHomeDir;
}

export function getTmpHomePath() {
  return tmpHomeDir;
}

export function restoreHome() {
  if (savedHome != null) {
    process.env.HOME = savedHome;
    savedHome = null;
    if (tmpHomeDir) {
      try { rmSync(tmpHomeDir, { recursive: true, force: true }); } catch {}
    }
    tmpHomeDir = null;
  }
}