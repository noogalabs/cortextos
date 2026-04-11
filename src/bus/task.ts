import { existsSync, readdirSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';
import type { Task, Priority, TaskStatus, BusPaths, StaleTaskReport, ArchiveReport } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { randomDigits } from '../utils/random.js';
import { validatePriority } from '../utils/validate.js';

/**
 * Create a new task. Identical JSON format to bash create-task.sh.
 */
export function createTask(
  paths: BusPaths,
  agentName: string,
  org: string,
  title: string,
  options: {
    description?: string;
    assignee?: string;
    priority?: Priority;
    project?: string;
    needsApproval?: boolean;
    dueDate?: string;
  } = {},
): string {
  const {
    description = '',
    assignee = agentName,
    priority = 'normal',
    project = '',
    needsApproval = false,
    dueDate = '',
  } = options;

  validatePriority(priority);

  const epoch = Date.now();
  const rand = randomDigits(3);
  const taskId = `task_${epoch}_${rand}`;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const task: Task = {
    id: taskId,
    title,
    description,
    type: 'agent',
    needs_approval: needsApproval,
    status: 'pending',
    assigned_to: assignee,
    created_by: agentName,
    org,
    priority,
    project,
    kpi_key: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    due_date: dueDate || null,
    archived: false,
  };

  ensureDir(paths.taskDir);
  atomicWriteSync(join(paths.taskDir, `${taskId}.json`), JSON.stringify(task));

  return taskId;
}

/**
 * Find the on-disk path of a task file by ID, supporting cross-org lookup.
 *
 * cortextOS's standard dispatch pattern is an orchestrator in one org
 * filing tasks that get assigned to specialists in other orgs. Before
 * this helper existed, updateTask
 * and completeTask hardcoded `join(paths.taskDir, taskId + '.json')` — which
 * points at the CURRENT agent's org tasks dir — so the specialist could not
 * drive the lifecycle of any task that was filed from a sibling org. Every
 * cross-org assignment required a manual workaround dance where the filer
 * ran update/complete on behalf of the assignee.
 *
 * This helper fixes that by using a two-tier lookup:
 *
 *   1. Fast path: check the caller's OWN org tasks dir first. Most tasks
 *      live there and this check pays zero scan cost when it hits.
 *   2. Fallback: scan every sibling org under `<ctxRoot>/orgs/*` for a
 *      matching task file. Only runs when the fast path missed, so
 *      same-org operations take no perf hit.
 *
 * Task IDs are generated as `task_<epoch_ms>_<3digit_random>` so real
 * collisions are effectively impossible — but if the scan ever finds the
 * same ID in multiple orgs (e.g. due to a bug in ID generation or a manual
 * file copy), we warn loudly naming the task ID, the match count, AND the
 * org names so an operator can investigate without having to grep the IDs
 * themselves. We still return the first match and keep operations flowing;
 * erroring on a theoretical collision would be worse UX than the warn.
 *
 * Exported because the helper is a useful primitive for any future caller
 * that needs cross-org task lookup (e.g. a hypothetical `get-task` command,
 * task-graph visualization, or cross-org list-tasks flag).
 */
export function findTaskFile(paths: BusPaths, taskId: string): string | null {
  // Fast path: same-org lookup.
  const sameOrg = join(paths.taskDir, `${taskId}.json`);
  if (existsSync(sameOrg)) return sameOrg;

  // Fallback: cross-org scan.
  const orgsRoot = join(paths.ctxRoot, 'orgs');
  const matches: Array<{ path: string; org: string }> = [];
  try {
    for (const entry of readdirSync(orgsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(orgsRoot, entry.name, 'tasks', `${taskId}.json`);
      if (existsSync(candidate)) {
        matches.push({ path: candidate, org: entry.name });
      }
    }
  } catch {
    return null; // orgs/ missing or unreadable
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const orgList = matches.map((m) => m.org).join(', ');
    console.warn(
      `[task] Ambiguous task id ${taskId}: found in ${matches.length} orgs (${orgList}). ` +
      `Operating on the first match in org '${matches[0].org}'. ` +
      `Review task ID generation if this recurs.`,
    );
  }
  return matches[0].path;
}

/**
 * Update a task's status. Matches bash update-task.sh behavior, with the
 * cross-org fallback from findTaskFile so an assignee in one org can drive
 * the lifecycle of a task filed by an orchestrator in a sibling org.
 */
export function updateTask(
  paths: BusPaths,
  taskId: string,
  status: TaskStatus,
): void {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`,
    );
  }
  try {
    const content = readFileSync(filePath, 'utf-8');
    const task: Task = JSON.parse(content);
    task.status = status;
    task.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    atomicWriteSync(filePath, JSON.stringify(task));
  } catch (err) {
    throw new Error(`Task ${taskId} update failed: ${err}`);
  }
}

/**
 * Complete a task. Sets status to done, completed_at, and optional result.
 * Matches bash complete-task.sh behavior, with the cross-org fallback from
 * findTaskFile so an assignee in one org can complete a task filed by an
 * orchestrator in a sibling org.
 */
export function completeTask(
  paths: BusPaths,
  taskId: string,
  result?: string,
): void {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`,
    );
  }
  try {
    const content = readFileSync(filePath, 'utf-8');
    const task: Task = JSON.parse(content);
    task.status = 'completed';
    task.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    task.completed_at = task.updated_at;
    if (result) {
      task.result = result;
    }
    atomicWriteSync(filePath, JSON.stringify(task));
  } catch (err) {
    throw new Error(`Task ${taskId} complete failed: ${err}`);
  }
}

/**
 * List tasks with optional filters.
 * Matches bash list-tasks.sh behavior.
 */
export function listTasks(
  paths: BusPaths,
  filters?: {
    agent?: string;
    status?: TaskStatus;
    priority?: Priority;
  },
): Task[] {
  const { taskDir } = paths;
  let files: string[];
  try {
    files = readdirSync(taskDir).filter(
      f => f.startsWith('task_') && f.endsWith('.json'),
    );
  } catch {
    return [];
  }

  const tasks: Task[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(taskDir, file), 'utf-8');
      const task: Task = JSON.parse(content);

      // Apply filters
      if (filters?.agent && task.assigned_to !== filters.agent) continue;
      if (filters?.status && task.status !== filters.status) continue;
      if (filters?.priority && task.priority !== filters.priority) continue;
      if (task.archived) continue;

      tasks.push(task);
    } catch {
      // Skip corrupt files
    }
  }

  return tasks.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

/**
 * Helper: read all task JSON files from a directory (non-recursive).
 */
function readAllTasks(taskDir: string): Task[] {
  let files: string[];
  try {
    files = readdirSync(taskDir).filter(
      f => f.startsWith('task_') && f.endsWith('.json'),
    );
  } catch {
    return [];
  }

  const tasks: Task[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(taskDir, file), 'utf-8');
      tasks.push(JSON.parse(content));
    } catch {
      // Skip corrupt files
    }
  }
  return tasks;
}

/**
 * Check for stale tasks. Matches bash check-stale-tasks.sh behavior.
 */
export function checkStaleTasks(paths: BusPaths): StaleTaskReport {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const STALE_IN_PROGRESS = 7200;   // 2 hours
  const STALE_PENDING = 86400;      // 24 hours
  const STALE_HUMAN = 86400;        // 24 hours

  const report: StaleTaskReport = {
    stale_in_progress: [],
    stale_pending: [],
    stale_human: [],
    overdue: [],
  };

  const tasks = readAllTasks(paths.taskDir);

  for (const task of tasks) {
    // Skip completed/done tasks
    if (task.status === 'completed' || task.status === 'cancelled') continue;

    const updatedEpoch = Math.floor(new Date(task.updated_at).getTime() / 1000);
    const createdEpoch = Math.floor(new Date(task.created_at).getTime() / 1000);
    const age = nowEpoch - updatedEpoch;
    const createdAge = nowEpoch - createdEpoch;

    // Stale in_progress: updated_at > 2 hours ago
    if (task.status === 'in_progress' && age > STALE_IN_PROGRESS) {
      report.stale_in_progress.push(task);
    }

    // Stale pending: created_at > 24 hours ago
    if (task.status === 'pending' && createdAge > STALE_PENDING) {
      report.stale_pending.push(task);
    }

    // Human tasks: assigned to "human" or "user", or in human-tasks project
    if (
      (['human', 'user'].includes(task.assigned_to ?? '') ||
        task.project === 'human-tasks') &&
      createdAge > STALE_HUMAN
    ) {
      report.stale_human.push(task);
    }

    // Overdue: has due_date and it's in the past
    if (task.due_date) {
      const dueEpoch = Math.floor(new Date(task.due_date).getTime() / 1000);
      if (dueEpoch > 0 && nowEpoch > dueEpoch) {
        report.overdue.push(task);
      }
    }
  }

  return report;
}

/**
 * Archive completed tasks older than 7 days. Matches bash archive-tasks.sh behavior.
 */
export function archiveTasks(paths: BusPaths, dryRun: boolean = false): ArchiveReport {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const ARCHIVE_AGE = 604800; // 7 days

  let archived = 0;
  let skipped = 0;

  const tasks = readAllTasks(paths.taskDir);

  for (const task of tasks) {
    // Only archive completed tasks
    if (task.status !== 'completed') continue;

    if (!task.completed_at) {
      skipped++;
      continue;
    }

    const completedEpoch = Math.floor(new Date(task.completed_at).getTime() / 1000);
    const age = nowEpoch - completedEpoch;

    if (age > ARCHIVE_AGE) {
      if (!dryRun) {
        const archiveDir = join(paths.taskDir, 'archive');
        ensureDir(archiveDir);

        // Mark as archived
        task.archived = true;
        const srcPath = join(paths.taskDir, `${task.id}.json`);
        atomicWriteSync(srcPath, JSON.stringify(task));

        // Move to archive
        renameSync(srcPath, join(archiveDir, `${task.id}.json`));
      }
      archived++;
    }
  }

  return { archived, skipped, dry_run: dryRun };
}

/**
 * Find stale human-assigned tasks. Matches bash check-human-tasks.sh behavior.
 */
export function checkHumanTasks(paths: BusPaths): Task[] {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const STALE_THRESHOLD = 86400; // 24 hours

  const tasks = readAllTasks(paths.taskDir);
  const result: Task[] = [];

  for (const task of tasks) {
    if (task.status === 'completed' || task.status === 'cancelled') continue;
    if (task.assigned_to !== 'human' && task.assigned_to !== 'user') continue;

    const createdEpoch = Math.floor(new Date(task.created_at).getTime() / 1000);
    const age = nowEpoch - createdEpoch;

    if (age > STALE_THRESHOLD) {
      result.push(task);
    }
  }

  return result;
}
