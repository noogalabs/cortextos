import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { BusPaths } from '../types/index.js';

/**
 * Knowledge base integration — calls mmrag.py directly (cross-platform,
 * no bash dependency).  Previously wrapped kb-*.sh bash scripts.
 */

/**
 * Resolve the Python interpreter inside the knowledge-base venv,
 * accounting for Windows vs Unix layout.
 */
function getVenvPython(frameworkRoot: string): string {
  const isWin = process.platform === 'win32';
  const venvBin = isWin ? 'Scripts' : 'bin';
  const pythonExe = isWin ? 'python.exe' : 'python3';
  return join(frameworkRoot, 'knowledge-base', 'venv', venvBin, pythonExe);
}

/**
 * Load .env and secrets.env files the same way the bash scripts did
 * (`set -o allexport && source …`).  Returns a flat key→value map.
 */
function loadSecretsEnv(frameworkRoot: string, org: string): Record<string, string> {
  const secretsPath = join(frameworkRoot, 'orgs', org, 'secrets.env');
  const dotenvPath = join(frameworkRoot, '.env');
  const vars: Record<string, string> = {};
  for (const p of [dotenvPath, secretsPath]) {
    if (existsSync(p)) {
      for (const line of readFileSync(p, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          let val = trimmed.slice(idx + 1);
          // Strip surrounding quotes (single or double) that some .env files use
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          vars[trimmed.slice(0, idx)] = val;
        }
      }
    }
  }
  return vars;
}

/**
 * Build the full env object needed by mmrag.py calls.
 */
function buildKBEnv(
  frameworkRoot: string,
  org: string,
  instanceId: string,
  agent?: string,
): Record<string, string> {
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', org, 'knowledge-base');
  const secrets = loadSecretsEnv(frameworkRoot, org);
  return {
    ...process.env as Record<string, string>,
    ...secrets,
    CTX_ORG: org,
    CTX_AGENT_NAME: agent || '',
    CTX_INSTANCE_ID: instanceId,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    MMRAG_DIR: kbRoot,
    MMRAG_CHROMADB_DIR: join(kbRoot, 'chromadb'),
    MMRAG_CONFIG: join(kbRoot, 'config.json'),
  };
}

export interface KBQueryResult {
  content: string;
  source_file: string;
  agent_name?: string;
  org: string;
  score: number;
  doc_type: string;
}

export interface KBQueryResponse {
  results: KBQueryResult[];
  total: number;
  query: string;
  collection: string;
}

/**
 * Query the knowledge base.
 * Returns parsed JSON results when --json is used internally.
 */
export function queryKnowledgeBase(
  paths: BusPaths,
  question: string,
  options: {
    org: string;
    agent?: string;
    scope?: 'shared' | 'private' | 'all';
    topK?: number;
    threshold?: number;
    frameworkRoot: string;
    instanceId: string;
  },
): KBQueryResponse {
  const { org, agent, scope = 'all', topK = 5, threshold = 0.5, frameworkRoot, instanceId } = options;

  const env = buildKBEnv(frameworkRoot, org, instanceId, agent);
  const pythonPath = getVenvPython(frameworkRoot);
  const mmragPath = join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  // Determine which collections to query based on scope
  const collections: string[] = [];
  switch (scope) {
    case 'shared':
      collections.push(`shared-${org}`);
      break;
    case 'private':
      collections.push(agent ? `agent-${agent}` : `shared-${org}`);
      break;
    case 'all':
      collections.push(`shared-${org}`);
      if (agent) collections.push(`agent-${agent}`);
      break;
  }

  const runQuery = (col: string): string | null => {
    try {
      return execFileSync(pythonPath, [
        mmragPath, 'query', question,
        '--collection', col,
        '--top-k', String(topK),
        '--threshold', String(threshold),
        '--json',
      ], {
        encoding: 'utf-8',
        timeout: 30000,
        env,
      });
    } catch {
      return null;
    }
  };

  const parseOutput = (output: string | null): KBQueryResult[] => {
    if (!output) return [];
    // mmrag.py --json outputs pretty-printed JSON; find and parse the JSON block
    const trimmed = output.trim();
    const jsonStart = trimmed.indexOf('{');
    if (jsonStart === -1) return [];
    try {
      const raw = JSON.parse(trimmed.slice(jsonStart)) as {
        results?: Array<{ content?: string; result?: string; similarity?: number; source?: string; type?: string }>;
        result_count?: number;
        query?: string;
        collection?: string;
      };
      return (raw.results || []).map((r) => ({
        content: r.content || r.result || '',
        source_file: r.source || '',
        org,
        agent_name: agent,
        score: r.similarity ?? 0,
        doc_type: r.type || 'markdown',
      }));
    } catch {
      return [];
    }
  };

  try {
    let allResults: KBQueryResult[] = [];
    let lastCollection = `shared-${org}`;
    for (const col of collections) {
      const output = runQuery(col);
      allResults = allResults.concat(parseOutput(output));
      lastCollection = col;
    }

    if (allResults.length > 0) {
      return {
        results: allResults,
        total: allResults.length,
        query: question,
        collection: collections.length === 1 ? lastCollection : `shared-${org}`,
      };
    }
  } catch {
    // Failed — return empty
  }

  return { results: [], total: 0, query: question, collection: `shared-${org}` };
}

/**
 * Ingest files into the knowledge base.
 */
export function ingestKnowledgeBase(
  paths: string[],
  options: {
    org: string;
    agent?: string;
    scope?: 'shared' | 'private';
    force?: boolean;
    frameworkRoot: string;
    instanceId: string;
  },
): void {
  const { org, agent, scope = 'shared', force, frameworkRoot, instanceId } = options;

  const env = buildKBEnv(frameworkRoot, org, instanceId, agent);
  const pythonPath = getVenvPython(frameworkRoot);
  const mmragPath = join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  // Determine collection name (same logic as kb-ingest.sh)
  let collection: string;
  if (scope === 'private') {
    if (!agent) throw new Error('--agent or CTX_AGENT_NAME required for --scope private');
    collection = `agent-${agent}`;
  } else {
    collection = `shared-${org}`;
  }

  // Ensure chromadb dir exists
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', org, 'knowledge-base');
  const chromaDir = join(kbRoot, 'chromadb');
  if (!existsSync(chromaDir)) {
    mkdirSync(chromaDir, { recursive: true });
  }

  console.log(`Ingesting into collection: ${collection}`);
  for (const p of paths) {
    console.log(`  Source: ${p}`);
  }

  const args = [mmragPath, 'ingest', ...paths, '--collection', collection];
  if (force) args.push('--force');

  execFileSync(pythonPath, args, {
    encoding: 'utf-8',
    // 5 min per batch — mmrag.py embeds files incrementally and a large batch
    // (or a slow Gemini tail latency) can exceed the previous 120s budget.
    // Callers with very large file sets should use ingestKnowledgeBaseChunked
    // (see `cortextos bus kb-ingest-chunked`), which bounds each subprocess
    // call to a configurable chunk size regardless of this ceiling.
    timeout: 300000,
    env,
    stdio: 'inherit',
  });

  console.log(`\nIngest complete → collection: ${collection}`);
}

export interface ChunkedIngestResult {
  totalFiles: number;
  totalBatches: number;
  successFiles: number;
  failedFiles: number;
  successBatches: number;
  failedBatches: number[];
}

/**
 * Chunked variant of {@link ingestKnowledgeBase} for large file sets.
 *
 * Splits `paths` into batches of `batchSize` (default 25) and runs
 * {@link ingestKnowledgeBase} once per batch. On a per-batch failure it
 * records the batch number, continues with the next batch, and returns a
 * summary so the caller can decide what to retry.
 *
 * Important behavior note: `mmrag.py` commits embeddings to the Chroma
 * store incrementally as it processes each file, not atomically at the end
 * of a batch. If a batch is killed mid-run (e.g. by the execFileSync
 * timeout), any files processed before the kill are already persisted.
 * Re-running the same paths will dedup those files automatically, so the
 * safe recovery pattern for a failed batch is: re-run `kb-ingest-chunked`
 * with the same inputs (optionally a smaller `batchSize`) and let the
 * content-hash dedup handle the already-committed portion.
 */
export function ingestKnowledgeBaseChunked(
  paths: string[],
  options: {
    org: string;
    agent?: string;
    scope?: 'shared' | 'private';
    force?: boolean;
    frameworkRoot: string;
    instanceId: string;
    batchSize?: number;
  },
): ChunkedIngestResult {
  // Preflight: run ALL deterministic setup BEFORE entering the batch loop.
  // The inner ingestKnowledgeBase() also performs these steps (config check
  // AND mkdirSync), but catching those throws inside the loop would silently
  // convert a single misconfiguration OR a real filesystem failure into a
  // cascade of fake per-batch failures — hiding the real cause. Do the work
  // once up front and let setup errors propagate to the caller. Covers:
  //   1. scope/agent combo validation (matches ingestKnowledgeBase line 220)
  //   2. KB chromadb directory creation (matches ingestKnowledgeBase line 229)
  // The inner function keeps its own copies of these checks so direct callers
  // still work; after the preflight they are idempotent no-ops.
  const scope = options.scope ?? 'shared';
  if (scope === 'private' && !options.agent) {
    throw new Error('--agent or CTX_AGENT_NAME required for --scope private');
  }
  ensureKBDirs(options.instanceId, options.org);

  const batchSize = options.batchSize && options.batchSize > 0 ? options.batchSize : 25;
  const total = paths.length;
  const totalBatches = total === 0 ? 0 : Math.ceil(total / batchSize);

  const result: ChunkedIngestResult = {
    totalFiles: total,
    totalBatches,
    successFiles: 0,
    failedFiles: 0,
    successBatches: 0,
    failedBatches: [],
  };

  if (total === 0) {
    console.log('Chunked ingest: no paths provided, nothing to do');
    return result;
  }

  console.log(
    `Chunked ingest: ${total} file(s) in ${totalBatches} batch(es) of ${batchSize}`,
  );

  for (let i = 0; i < total; i += batchSize) {
    const batchNum = Math.floor(i / batchSize) + 1;
    const chunk = paths.slice(i, i + batchSize);

    console.log(`\n[batch ${batchNum}/${totalBatches}] ${chunk.length} file(s)`);

    try {
      ingestKnowledgeBase(chunk, {
        org: options.org,
        agent: options.agent,
        scope,
        force: options.force,
        frameworkRoot: options.frameworkRoot,
        instanceId: options.instanceId,
      });
      result.successFiles += chunk.length;
      result.successBatches += 1;
    } catch (err) {
      // Only subprocess/execution failures reach this catch — deterministic
      // config errors were caught by the preflight above and never enter
      // the loop. Upper-bound the failed count at chunk.length; mmrag.py
      // may have committed some files before the error, but that is opaque
      // from here. Re-running will dedup the already-committed portion.
      result.failedFiles += chunk.length;
      result.failedBatches.push(batchNum);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  BATCH ${batchNum} FAILED: ${msg}`);
      console.error('  Continuing with next batch. Re-run this command to retry the failed batch — committed files will be deduped.');
    }
  }

  console.log(
    `\nChunked ingest done: ${result.successFiles}/${total} file(s) in successful batches, ${result.failedFiles} file(s) in failed batches`,
  );
  if (result.failedBatches.length > 0) {
    console.log(`  Failed batches: ${result.failedBatches.join(', ')}`);
  }

  return result;
}

/**
 * Ensure the knowledge base directories exist for an org.
 */
export function ensureKBDirs(instanceId: string, org: string): void {
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', org, 'knowledge-base');
  const chromaDir = join(kbRoot, 'chromadb');
  if (!existsSync(chromaDir)) {
    mkdirSync(chromaDir, { recursive: true });
  }
}
