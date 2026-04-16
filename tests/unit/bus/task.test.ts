import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask, updateTask, completeTask, listTasks, findTaskFile } from '../../../src/bus/task';
import type { BusPaths } from '../../../src/types';

describe('Task Management', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-task-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'paul'),
      inflight: join(testDir, 'inflight', 'paul'),
      processed: join(testDir, 'processed', 'paul'),
      logDir: join(testDir, 'logs', 'paul'),
      stateDir: join(testDir, 'state', 'paul'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('createTask', () => {
    it('creates task with correct JSON format', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Build landing page', {
        description: 'Create a product landing page',
        assignee: 'boris',
        priority: 'high',
      });

      expect(taskId).toMatch(/^task_\d+_\d{3}$/);

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));

      // Verify all 17 fields match bash create-task.sh format
      expect(content.id).toBe(taskId);
      expect(content.title).toBe('Build landing page');
      expect(content.description).toBe('Create a product landing page');
      expect(content.type).toBe('agent');
      expect(content.needs_approval).toBe(false);
      expect(content.status).toBe('pending');
      expect(content.assigned_to).toBe('boris');
      expect(content.created_by).toBe('paul');
      expect(content.org).toBe('acme');
      expect(content.priority).toBe('high');
      expect(content.project).toBe('');
      expect(content.kpi_key).toBeNull();
      expect(content.created_at).toBeTruthy();
      expect(content.updated_at).toBeTruthy();
      expect(content.completed_at).toBeNull();
      expect(content.due_date).toBeNull();
      expect(content.archived).toBe(false);
    });
  });

  describe('updateTask', () => {
    it('updates task status', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task');
      updateTask(paths, taskId, 'in_progress');

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.status).toBe('in_progress');
    });
  });

  describe('completeTask', () => {
    it('sets status to completed and completed_at', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task');
      completeTask(paths, taskId, 'Landing page done, committed at abc123');

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.status).toBe('completed');
      expect(content.completed_at).toBeTruthy();
      expect(content.result).toBe('Landing page done, committed at abc123');
    });
  });

  describe('listTasks', () => {
    it('returns all non-archived tasks', () => {
      createTask(paths, 'paul', 'acme', 'Task 1');
      createTask(paths, 'paul', 'acme', 'Task 2');

      const tasks = listTasks(paths);
      expect(tasks.length).toBe(2);
    });

    it('filters by agent', () => {
      createTask(paths, 'paul', 'acme', 'For boris', { assignee: 'boris' });
      createTask(paths, 'paul', 'acme', 'For paul', { assignee: 'paul' });

      const borisTasks = listTasks(paths, { agent: 'boris' });
      expect(borisTasks.length).toBe(1);
      expect(borisTasks[0].title).toBe('For boris');
    });

    it('filters by status', () => {
      const id1 = createTask(paths, 'paul', 'acme', 'Task 1');
      createTask(paths, 'paul', 'acme', 'Task 2');
      updateTask(paths, id1, 'completed');

      const pending = listTasks(paths, { status: 'pending' });
      expect(pending.length).toBe(1);
    });
  });
});

/**
 * Cross-org task lifecycle — exercises the findTaskFile fallback so an
 * assignee in one org can drive the lifecycle of a task filed by an
 * orchestrator in a sibling org. Standard cortextOS dispatch pattern:
 * an orchestrator in one org files a task, a specialist in another org
 * needs to update and complete it from their own agent session.
 *
 * These tests build a REAL nested filesystem layout (matching the
 * production shape at ~/.cortextos/<instance>/orgs/<org>/tasks/) so they
 * cover the actual cross-org path resolution, not a mocked shortcut.
 */
describe('Cross-org task lifecycle', () => {
  let testDir: string;
  let orgAPaths: BusPaths;
  let orgBTaskDir: string;
  let warnLog: string[];
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-crossorg-test-'));
    // Nested layout: <ctxRoot>/orgs/{OrgA,OrgB}/tasks/
    mkdirSync(join(testDir, 'orgs', 'OrgA', 'tasks'), { recursive: true });
    mkdirSync(join(testDir, 'orgs', 'OrgB', 'tasks'), { recursive: true });

    orgAPaths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'agentA'),
      inflight: join(testDir, 'inflight', 'agentA'),
      processed: join(testDir, 'processed', 'agentA'),
      logDir: join(testDir, 'logs', 'agentA'),
      stateDir: join(testDir, 'state', 'agentA'),
      taskDir: join(testDir, 'orgs', 'OrgA', 'tasks'),
      approvalDir: join(testDir, 'orgs', 'OrgA', 'approvals'),
      analyticsDir: join(testDir, 'orgs', 'OrgA', 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    orgBTaskDir = join(testDir, 'orgs', 'OrgB', 'tasks');

    warnLog = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnLog.push(args.map((a) => String(a)).join(' '));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    rmSync(testDir, { recursive: true, force: true });
  });

  /** Helper: drop a raw task JSON file into OrgB's tasks dir without
   * going through createTask (which only knows about OrgA's taskDir). */
  function writeOrgBTask(taskId: string, overrides: Record<string, unknown> = {}): void {
    const task = {
      id: taskId,
      title: 'Cross-org task',
      description: '',
      type: 'agent',
      needs_approval: false,
      status: 'pending',
      assigned_to: 'agentA',
      created_by: 'orchestrator',
      org: 'OrgB',
      priority: 'normal',
      project: '',
      kpi_key: null,
      created_at: '2026-04-11T20:00:00Z',
      updated_at: '2026-04-11T20:00:00Z',
      completed_at: null,
      due_date: null,
      archived: false,
      ...overrides,
    };
    writeFileSync(join(orgBTaskDir, `${taskId}.json`), JSON.stringify(task), 'utf-8');
  }

  it('updateTask same-org happy path: still works via the fast path', () => {
    // Regression guard for the existing single-org behavior. This is the
    // hot path and must not pay any cross-org scan cost when it hits.
    const taskId = createTask(orgAPaths, 'agentA', 'OrgA', 'Same-org task');
    updateTask(orgAPaths, taskId, 'in_progress');

    const content = JSON.parse(
      readFileSync(join(orgAPaths.taskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(content.status).toBe('in_progress');
  });

  it('updateTask cross-org: finds task in sibling org via findTaskFile fallback', () => {
    // Repro: file a task in OrgB, try to update it from an OrgA-scoped
    // session. Before findTaskFile, this threw "Task not found" because
    // updateTask only looked at orgAPaths.taskDir.
    const taskId = 'task_test_001';
    writeOrgBTask(taskId);

    updateTask(orgAPaths, taskId, 'in_progress');

    // Verify the OrgB file got updated, NOT the (nonexistent) OrgA file.
    const orgBContent = JSON.parse(
      readFileSync(join(orgBTaskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(orgBContent.status).toBe('in_progress');
    // Explicit timestamp comparison: the seed updated_at is a fixed moment
    // in the past, so the real Date.now() that updateTask stamps MUST be
    // strictly greater. Avoids the brittle string-inequality form that
    // would silently pass on any future refactor that changed the seed.
    expect(new Date(orgBContent.updated_at).getTime()).toBeGreaterThan(
      new Date('2026-04-11T20:00:00Z').getTime(),
    );
    expect(existsSync(join(orgAPaths.taskDir, `${taskId}.json`))).toBe(false);
  });

  it('updateTask not found anywhere: throws with a clear error naming ctxRoot', () => {
    expect(() => updateTask(orgAPaths, 'task_999_000', 'in_progress')).toThrow(
      /not found in any org under .*\/orgs\//,
    );
  });

  it('completeTask cross-org: finds task in sibling org and marks it done', () => {
    const taskId = 'task_test_002';
    writeOrgBTask(taskId);

    completeTask(orgAPaths, taskId, 'cross-org completion');

    const orgBContent = JSON.parse(
      readFileSync(join(orgBTaskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(orgBContent.status).toBe('completed');
    expect(orgBContent.completed_at).toBeTruthy();
    expect(orgBContent.result).toBe('cross-org completion');
  });

  it('findTaskFile ambiguity: same ID in two orgs triggers warn naming both orgs', () => {
    // Manually create the same task id in BOTH orgs. Real collisions
    // should be vanishingly rare (epoch_ms + 3 digits), but the warn path
    // must be tested so operators hitting it in production get actionable
    // information.
    const taskId = 'task_1_000';
    writeOrgBTask(taskId);
    // Write the same ID to OrgA via direct filesystem (bypassing
    // createTask so we can reuse the exact ID).
    const orgATaskPath = join(orgAPaths.taskDir, `${taskId}.json`);
    writeFileSync(
      orgATaskPath,
      JSON.stringify({
        id: taskId,
        title: 'OrgA collision',
        status: 'pending',
        org: 'OrgA',
        updated_at: '2026-04-11T20:00:00Z',
        created_at: '2026-04-11T20:00:00Z',
      }),
      'utf-8',
    );

    // findTaskFile should return the OrgA path (same-org fast path wins)
    // without ever emitting the ambiguity warning. The fast path only
    // checks same-org; the cross-org scan is ONLY exercised when same-org
    // misses. So the ambiguity warning path requires same-org to miss
    // AND multiple sibling orgs to hit.
    //
    // To exercise the warn, delete the OrgA copy and write collisions
    // into two OTHER orgs.
    rmSync(orgATaskPath);
    mkdirSync(join(testDir, 'orgs', 'OrgC', 'tasks'), { recursive: true });
    writeFileSync(
      join(testDir, 'orgs', 'OrgC', 'tasks', `${taskId}.json`),
      JSON.stringify({
        id: taskId,
        title: 'OrgC collision',
        status: 'pending',
        org: 'OrgC',
        updated_at: '2026-04-11T20:00:00Z',
        created_at: '2026-04-11T20:00:00Z',
      }),
      'utf-8',
    );

    const result = findTaskFile(orgAPaths, taskId);
    expect(result).not.toBeNull();
    // Warn must have fired and must name BOTH the task id and the two orgs.
    expect(warnLog.length).toBeGreaterThanOrEqual(1);
    const warn = warnLog[0];
    expect(warn).toContain(taskId);
    expect(warn).toMatch(/found in 2 orgs/);
    expect(warn).toContain('OrgB');
    expect(warn).toContain('OrgC');
  });

  it('listTasks scoping regression: must remain single-org, NO cross-org leakage', () => {
    // CRITICAL regression guard. Scoping contract:
    // listTasks must remain single-org by default — cross-org listing
    // requires an explicit opt-in flag that does not exist yet. A future
    // well-meaning refactor that 'helpfully' makes listTasks cross-org by
    // default would silently break the dashboard, which depends on
    // per-org scoping for its sync loop. If this test fails, the refactor
    // broke the contract and must be reverted or gated behind an opt-in
    // flag.
    const sameOrgId = createTask(orgAPaths, 'agentA', 'OrgA', 'Same-org task');
    writeOrgBTask('task_other_1', { title: 'Sibling-org task 1' });
    writeOrgBTask('task_other_2', { title: 'Sibling-org task 2' });

    const tasks = listTasks(orgAPaths);
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe(sameOrgId);
    expect(tasks[0].title).toBe('Same-org task');
  });
});
