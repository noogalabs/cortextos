/**
 * tests/integration/cron-config-sync.test.ts — cron-sync gap fix
 *
 * Covers syncCronsForAgent(), the daemon's boot-time config.json → crons.json
 * synchronization entry point (called from AgentManager.startAgent()).
 *
 * THE BUG BEING FIXED: migrateCronsForAgent() is marker-gated and runs ONCE
 * per agent. Any cron added to config.json AFTER the first migration never
 * reached crons.json (the canonical live source the CronScheduler reads)
 * unless an operator manually ran `cortextos bus reload-crons`. Editing
 * config.json silently did nothing.
 *
 * Scenarios:
 *  1. First boot: sync == one-shot migration (marker written, unchanged semantics)
 *  2. THE GAP: cron added to config.json after first migration reaches
 *     crons.json on the next sync AND is scheduled by a fresh CronScheduler
 *  3. Runtime metadata (fire_count, last_fired_at, last_fire_attempted_at,
 *     created_at) preserved across sync for existing crons
 *  4. Orphan crons (live-only, added via bus add-cron, absent from config)
 *     preserved across sync — never auto-pruned
 *  5. No double-firing: scheduler nextFireAt derives from preserved
 *     last_fired_at — no spurious catch-up fire after a sync, and new crons
 *     get a future-dated first fire
 *  6. Missing config.json: sync no-ops without wiping crons.json
 *  7. Re-sync with no config change: idempotent, no duplicates, metadata intact
 *
 * All tests use temp directories only — no real config.json or crons.json
 * files are touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import type { CronDefinition } from '../../src/types/index.js';

const CRONS_DIR = '.cortextOS/state/agents';
const CRONS_FILE = 'crons.json';
const MARKER_FILE = '.crons-migrated';

let tmpCtxRoot: string;
let tmpFrameworkRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

// Dynamically imported module references (re-imported per test after vi.resetModules)
let syncCronsForAgent: typeof import('../../src/daemon/cron-migration.js').syncCronsForAgent;
let migrateCronsForAgent: typeof import('../../src/daemon/cron-migration.js').migrateCronsForAgent;
let readCrons: typeof import('../../src/bus/crons.js').readCrons;
let updateCron: typeof import('../../src/bus/crons.js').updateCron;
let addCron: typeof import('../../src/bus/crons.js').addCron;
let CronSchedulerCtor: typeof import('../../src/daemon/cron-scheduler.js').CronScheduler;

async function reloadModules() {
  vi.resetModules();
  const migModule = await import('../../src/daemon/cron-migration.js');
  syncCronsForAgent = migModule.syncCronsForAgent;
  migrateCronsForAgent = migModule.migrateCronsForAgent;
  const cronsModule = await import('../../src/bus/crons.js');
  readCrons = cronsModule.readCrons;
  updateCron = cronsModule.updateCron;
  addCron = cronsModule.addCron;
  const schedModule = await import('../../src/daemon/cron-scheduler.js');
  CronSchedulerCtor = schedModule.CronScheduler;
}

function writeConfigJson(agentDir: string, crons: unknown[]): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({ agent_name: 'test', enabled: true, crons }),
    'utf-8',
  );
}

function markerExists(ctxRoot: string, agentName: string): boolean {
  return existsSync(join(ctxRoot, CRONS_DIR, agentName, MARKER_FILE));
}

beforeEach(async () => {
  tmpCtxRoot = mkdtempSync(join(tmpdir(), 'cron-config-sync-ctx-'));
  tmpFrameworkRoot = mkdtempSync(join(tmpdir(), 'cron-config-sync-fw-'));
  process.env.CTX_ROOT = tmpCtxRoot;
  await reloadModules();
});

afterEach(() => {
  vi.resetModules();
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }
  try { rmSync(tmpCtxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(tmpFrameworkRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Set up an agent dir, write config crons, run the first-boot migration. */
function firstBoot(agentName: string, crons: unknown[]): string {
  const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', agentName);
  writeConfigJson(agentDir, crons);
  const configPath = join(agentDir, 'config.json');
  const result = migrateCronsForAgent(agentName, configPath, tmpCtxRoot, { log: () => {} });
  expect(result.status).toBe('migrated');
  expect(markerExists(tmpCtxRoot, agentName)).toBe(true);
  return configPath;
}

const silent = { log: () => {} };

describe('syncCronsForAgent — cron-sync gap fix', () => {
  // -------------------------------------------------------------------------
  // 1. First boot path is unchanged
  // -------------------------------------------------------------------------
  it('first boot: runs the one-shot migration and writes the marker', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'fresh');
    writeConfigJson(agentDir, [
      { name: 'heartbeat', interval: '6h', prompt: 'Run heartbeat.' },
    ]);

    const result = syncCronsForAgent('fresh', join(agentDir, 'config.json'), tmpCtxRoot, silent);

    expect(result.mode).toBe('migrated');
    expect(result.migration?.status).toBe('migrated');
    expect(markerExists(tmpCtxRoot, 'fresh')).toBe(true);
    expect(readCrons('fresh').map(c => c.name)).toEqual(['heartbeat']);
  });

  // -------------------------------------------------------------------------
  // 2. THE GAP: post-migration config.json additions reach the live scheduler
  // -------------------------------------------------------------------------
  it('cron added to config.json AFTER first migration reaches crons.json and a fresh scheduler', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'gap');
    const configPath = firstBoot('gap', [
      { name: 'heartbeat', interval: '6h', prompt: 'Run heartbeat.' },
    ]);

    // Operator edits config.json after the first migration (the previously
    // silently-ignored action).
    writeConfigJson(agentDir, [
      { name: 'heartbeat', interval: '6h', prompt: 'Run heartbeat.' },
      { name: 'morning-review', cron: '0 7 * * *', prompt: 'Send the morning brief.' },
    ]);

    // Pre-fix behavior: marker present → migrate skips → 'morning-review'
    // never lands. Verify the migration alone still skips (the bug), then
    // that sync reconciles it (the fix).
    const migrateOnly = migrateCronsForAgent('gap', configPath, tmpCtxRoot, silent);
    expect(migrateOnly.status).toBe('skipped-already-migrated');
    expect(readCrons('gap').map(c => c.name)).toEqual(['heartbeat']);

    const result = syncCronsForAgent('gap', configPath, tmpCtxRoot, silent);

    expect(result.mode).toBe('reconciled');
    expect(result.reload?.added).toEqual(['morning-review']);
    expect(result.reload?.error).toBeUndefined();
    expect(readCrons('gap').map(c => c.name).sort()).toEqual(['heartbeat', 'morning-review']);

    // The daemon starts the CronScheduler AFTER the sync — prove the new cron
    // is actually scheduled (reaches the live scheduler, not just the file).
    const scheduler = new CronSchedulerCtor({
      agentName: 'gap',
      onFire: () => {},
      logger: () => {},
    });
    scheduler.start();
    try {
      const names = scheduler.getNextFireTimes().map(e => e.name).sort();
      expect(names).toEqual(['heartbeat', 'morning-review']);
    } finally {
      scheduler.stop();
    }
  });

  // -------------------------------------------------------------------------
  // 3. Runtime metadata preserved
  // -------------------------------------------------------------------------
  it('preserves fire_count / last_fired_at / created_at on existing crons across sync', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'meta');
    const configPath = firstBoot('meta', [
      { name: 'heartbeat', interval: '6h', prompt: 'Run heartbeat.' },
    ]);

    const createdAt = readCrons('meta')[0].created_at;

    // Simulate scheduler fires recorded on the live cron.
    updateCron('meta', 'heartbeat', {
      fire_count: 7,
      last_fired_at: '2026-06-09T12:00:00.000Z',
      last_fire_attempted_at: '2026-06-09T12:00:00.000Z',
    });

    // Operator adds a cron AND edits the heartbeat prompt in config.json.
    writeConfigJson(agentDir, [
      { name: 'heartbeat', interval: '6h', prompt: 'Run heartbeat v2.' },
      { name: 'evening-review', interval: '24h', prompt: 'Evening review.' },
    ]);

    const result = syncCronsForAgent('meta', configPath, tmpCtxRoot, silent);
    expect(result.mode).toBe('reconciled');
    expect(result.reload?.added).toEqual(['evening-review']);
    expect(result.reload?.updated).toEqual(['heartbeat']);

    const heartbeat = readCrons('meta').find(c => c.name === 'heartbeat')!;
    // Config-authoritative field updated…
    expect(heartbeat.prompt).toBe('Run heartbeat v2.');
    // …runtime metadata preserved (the trap).
    expect(heartbeat.fire_count).toBe(7);
    expect(heartbeat.last_fired_at).toBe('2026-06-09T12:00:00.000Z');
    expect(heartbeat.last_fire_attempted_at).toBe('2026-06-09T12:00:00.000Z');
    expect(heartbeat.created_at).toBe(createdAt);
  });

  // -------------------------------------------------------------------------
  // 4. Orphan (live-only) crons preserved
  // -------------------------------------------------------------------------
  it('preserves orphan crons added via bus add-cron (absent from config.json)', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'orphan');
    const configPath = firstBoot('orphan', [
      { name: 'heartbeat', interval: '6h', prompt: 'Run heartbeat.' },
    ]);

    // Runtime-only cron, never present in config.json.
    addCron('orphan', {
      name: 'runtime-only',
      prompt: 'Added at runtime via bus add-cron.',
      schedule: '30m',
      enabled: true,
      created_at: '2026-06-01T00:00:00.000Z',
      description: 'operator-set description',
    } as CronDefinition);

    // Two consecutive boots (sync runs on every agent start) — the orphan
    // must survive both, untouched.
    for (let boot = 0; boot < 2; boot++) {
      const result = syncCronsForAgent('orphan', configPath, tmpCtxRoot, silent);
      expect(result.mode).toBe('reconciled');
      expect(result.reload?.kept_orphan).toEqual(['runtime-only']);
      expect(result.reload?.pruned_orphan).toEqual([]);
    }

    const orphan = readCrons('orphan').find(c => c.name === 'runtime-only')!;
    expect(orphan).toBeDefined();
    expect(orphan.created_at).toBe('2026-06-01T00:00:00.000Z');
    expect(orphan.description).toBe('operator-set description');
  });

  // -------------------------------------------------------------------------
  // 5. No double-firing after sync
  // -------------------------------------------------------------------------
  it('no double-fire: scheduler computes nextFireAt from preserved last_fired_at; new crons fire in the future', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'nodouble');
    const configPath = firstBoot('nodouble', [
      { name: 'heartbeat', interval: '6h', prompt: 'Run heartbeat.' },
    ]);

    // Heartbeat fired 1 hour ago — next fire must be ~5h out, NOT an
    // immediate catch-up fire.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    updateCron('nodouble', 'heartbeat', {
      fire_count: 3,
      last_fired_at: oneHourAgo,
      last_fire_attempted_at: oneHourAgo,
    });

    writeConfigJson(agentDir, [
      { name: 'heartbeat', interval: '6h', prompt: 'Run heartbeat.' },
      { name: 'new-cron', interval: '1h', prompt: 'New work.' },
    ]);

    const result = syncCronsForAgent('nodouble', configPath, tmpCtxRoot, silent);
    expect(result.mode).toBe('reconciled');

    const fired: string[] = [];
    const scheduler = new CronSchedulerCtor({
      agentName: 'nodouble',
      onFire: (cron) => { fired.push(cron.name); },
      logger: () => {},
    });
    scheduler.start();
    try {
      const now = Date.now();
      const times = new Map(scheduler.getNextFireTimes().map(e => [e.name, e.nextFireAt]));

      // Preserved last_fired_at + 6h ≈ 5h in the future (±2 min tolerance).
      const expectedHeartbeat = new Date(oneHourAgo).getTime() + 6 * 60 * 60 * 1000;
      expect(Math.abs(times.get('heartbeat')! - expectedHeartbeat)).toBeLessThan(2 * 60 * 1000);
      expect(times.get('heartbeat')!).toBeGreaterThan(now);

      // New cron: first fire one interval out — not an immediate catch-up.
      expect(times.get('new-cron')!).toBeGreaterThan(now);

      // Nothing fired synchronously on start.
      expect(fired).toEqual([]);
    } finally {
      scheduler.stop();
    }
  });

  // -------------------------------------------------------------------------
  // 6. Missing config.json — never wipes crons.json
  // -------------------------------------------------------------------------
  it('missing config.json: sync no-ops with an error, crons.json untouched', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'noconf');
    const configPath = firstBoot('noconf', [
      { name: 'heartbeat', interval: '6h', prompt: 'Run heartbeat.' },
    ]);

    unlinkSync(configPath);

    const result = syncCronsForAgent('noconf', configPath, tmpCtxRoot, silent);
    expect(result.mode).toBe('reconciled');
    expect(result.reload?.error).toBeDefined();
    expect(readCrons('noconf').map(c => c.name)).toEqual(['heartbeat']);
  });

  // -------------------------------------------------------------------------
  // 6b. Corrupt crons.json (STATE) — never wipes; fail-loud no-op
  // -------------------------------------------------------------------------
  it('corrupt crons.json (primary + .bak): reconcile aborts, file preserved, no wipe', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'corruptstate');
    const configPath = firstBoot('corruptstate', [
      { name: 'heartbeat', interval: '6h', prompt: 'Run heartbeat.' },
    ]);
    // Catastrophic: corrupt BOTH the live state file and its .bak so there is
    // no recovery source — readCronsWithStatus returns corrupt=true.
    const cronsPath = join(tmpCtxRoot, CRONS_DIR, 'corruptstate', CRONS_FILE);
    const garbage = '{ this is not valid json';
    writeFileSync(cronsPath, garbage, 'utf-8');
    writeFileSync(cronsPath + '.bak', '<<< also broken', 'utf-8');
    // A new config cron that a HEALTHY reconcile would add — proves the abort
    // is what preserved the file, not an absence of pending changes.
    writeConfigJson(agentDir, [
      { name: 'heartbeat', interval: '6h', prompt: 'Run heartbeat.' },
      { name: 'newcron', interval: '1h', prompt: 'Run newcron.' },
    ]);

    const result = syncCronsForAgent('corruptstate', configPath, tmpCtxRoot, silent);
    expect(result.mode).toBe('reconciled');
    expect(result.reload?.error).toMatch(/corrupt/i);
    // The corrupt file is preserved verbatim — NOT overwritten with config-only.
    expect(readFileSync(cronsPath, 'utf-8')).toBe(garbage);
  });

  // -------------------------------------------------------------------------
  // 7. Idempotent re-sync
  // -------------------------------------------------------------------------
  it('re-sync with no config change is idempotent: no duplicates, metadata intact', () => {
    firstBoot('idem', [
      { name: 'heartbeat', interval: '6h', prompt: 'Run heartbeat.' },
    ]);
    const configPath = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'idem', 'config.json');

    updateCron('idem', 'heartbeat', { fire_count: 2, last_fired_at: '2026-06-09T00:00:00.000Z' });

    const first = syncCronsForAgent('idem', configPath, tmpCtxRoot, silent);
    const second = syncCronsForAgent('idem', configPath, tmpCtxRoot, silent);

    for (const result of [first, second]) {
      expect(result.mode).toBe('reconciled');
      expect(result.reload?.unchanged).toEqual(['heartbeat']);
      expect(result.reload?.added).toEqual([]);
      expect(result.reload?.updated).toEqual([]);
    }

    const crons = readCrons('idem');
    expect(crons).toHaveLength(1);
    expect(crons[0].fire_count).toBe(2);
    expect(crons[0].last_fired_at).toBe('2026-06-09T00:00:00.000Z');
  });
});
