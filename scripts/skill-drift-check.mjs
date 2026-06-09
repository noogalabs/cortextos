#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MANIFEST = 'scripts/skill-mirrors.json';

function usage() {
  return `Usage: node scripts/skill-drift-check.mjs [--tier ci|local] [--manifest path] [--root path] [--fix] [--write]

Checks declared shared skill directory mirrors against a canonical template copy.

Modes:
  --tier ci       Check only git-tracked mirror members; skip gitignored deployed copies.
  --tier local    Check all declared members, including gitignored deployed copies. Default.

Fix mode:
  --fix           Dry-run by default: report what would be copied, write nothing.
  --write         With --fix, overwrite declared mirror files that differ or are missing.
                  Extra files are treated as conflicts and are never removed automatically.
`;
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    tier: 'local',
    manifest: DEFAULT_MANIFEST,
    root: process.cwd(),
    fix: false,
    write: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tier') {
      opts.tier = argv[++i];
    } else if (arg === '--manifest') {
      opts.manifest = argv[++i];
    } else if (arg === '--root') {
      opts.root = argv[++i];
    } else if (arg === '--fix') {
      opts.fix = true;
    } else if (arg === '--write') {
      opts.write = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }

  if (!['ci', 'local'].includes(opts.tier)) {
    throw new Error(`--tier must be "ci" or "local" (got ${opts.tier})`);
  }
  if (opts.write && !opts.fix) {
    throw new Error('--write requires --fix');
  }
  opts.root = resolve(opts.root);
  opts.manifest = resolve(opts.root, opts.manifest);
  return opts;
}

function loadManifest(path) {
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Manifest must be an array: ${path}`);
  }
  return parsed.map((group, idx) => {
    if (!group || typeof group !== 'object') {
      throw new Error(`Manifest group ${idx} must be an object`);
    }
    for (const key of ['skill', 'canonical', 'mirrors']) {
      if (!(key in group)) throw new Error(`Manifest group ${idx} missing ${key}`);
    }
    if (!Array.isArray(group.mirrors)) {
      throw new Error(`Manifest group ${group.skill} mirrors must be an array`);
    }
    return group;
  });
}

function isSubpath(root, maybePath) {
  const rel = relative(root, maybePath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveMember(root, memberPath) {
  const resolved = resolve(root, memberPath);
  if (!isSubpath(root, resolved)) {
    throw new Error(`Refusing manifest path outside --root: ${memberPath}`);
  }
  return resolved;
}

function listFiles(dir) {
  const out = [];
  function walk(current) {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  }
  walk(dir);
  return out;
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function treeMap(dir) {
  if (!existsSync(dir)) {
    return null;
  }
  if (!statSync(dir).isDirectory()) {
    throw new Error(`Skill member is not a directory: ${dir}`);
  }
  const map = new Map();
  for (const file of listFiles(dir)) {
    map.set(relative(dir, file).split(sep).join('/'), hashFile(file));
  }
  return map;
}

function trackedFileCount(root, memberPath) {
  try {
    const output = execFileSync('git', ['-C', root, 'ls-files', '--', memberPath], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim() ? output.trim().split('\n').length : 0;
  } catch {
    return 0;
  }
}

function isTrackedMember(root, memberPath) {
  return trackedFileCount(root, memberPath) > 0;
}

function compareMaps(canonical, mirror) {
  const missing = [];
  const different = [];
  const extra = [];

  for (const [file, hash] of canonical.entries()) {
    if (!mirror.has(file)) {
      missing.push(file);
    } else if (mirror.get(file) !== hash) {
      different.push(file);
    }
  }
  for (const file of mirror.keys()) {
    if (!canonical.has(file)) {
      extra.push(file);
    }
  }

  return {
    missing: missing.sort(),
    different: different.sort(),
    extra: extra.sort(),
    ok: missing.length === 0 && different.length === 0 && extra.length === 0,
  };
}

function shortDiff(a, b) {
  try {
    return execFileSync('diff', ['-u', a, b], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024,
    });
  } catch (err) {
    return err.stdout || '';
  }
}

function applyFix({ root, group, canonicalAbs, mirrorAbs, mirrorPath, diff }) {
  const lines = [];
  if (diff.extra.length > 0) {
    lines.push(`  CONFLICT ${mirrorPath}: declared-shared but locally modified with extra file(s): ${diff.extra.join(', ')}. Resolve, not clobber.`);
    return { wrote: false, conflict: true, lines };
  }

  for (const file of [...diff.missing, ...diff.different].sort()) {
    const src = join(canonicalAbs, file);
    const dest = join(mirrorAbs, file);
    if (!isSubpath(root, dest)) {
      throw new Error(`Refusing to write outside --root: ${dest}`);
    }
    lines.push(`  ${file}: would copy canonical -> ${mirrorPath}/${file}`);
    if (existsSync(dest)) {
      const d = shortDiff(src, dest);
      if (d.trim()) {
        lines.push(d.split('\n').slice(0, 80).map(line => `    ${line}`).join('\n'));
      }
    }
  }

  return { wrote: false, conflict: false, lines };
}

function writeFix({ root, canonicalAbs, mirrorAbs, mirrorPath, diff }) {
  const lines = [];
  if (diff.extra.length > 0) {
    lines.push(`  CONFLICT ${mirrorPath}: declared-shared but locally modified with extra file(s): ${diff.extra.join(', ')}. Resolve, not clobber.`);
    return { wrote: false, conflict: true, lines };
  }

  for (const file of [...diff.missing, ...diff.different].sort()) {
    const src = join(canonicalAbs, file);
    const dest = join(mirrorAbs, file);
    if (!isSubpath(root, dest)) {
      throw new Error(`Refusing to write outside --root: ${dest}`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    lines.push(`  WARNING overwrite ${mirrorPath}/${file} from canonical`);
  }
  return { wrote: true, conflict: false, lines };
}

function checkGroup(group, opts) {
  const lines = [];
  const failures = [];
  const skipped = [];
  const canonicalAbs = resolveMember(opts.root, group.canonical);
  const canonicalMap = treeMap(canonicalAbs);
  lines.push(`\n${group.skill}`);
  lines.push(`  canonical: ${group.canonical}`);
  if (group.note) lines.push(`  note: ${group.note}`);

  if (!canonicalMap) {
    lines.push(`  FAIL canonical missing: ${group.canonical}`);
    return { lines, failures: [`${group.skill}: canonical missing`], skipped };
  }

  for (const mirrorPath of group.mirrors) {
    const mirrorAbs = resolveMember(opts.root, mirrorPath);
    const tracked = isTrackedMember(opts.root, mirrorPath);
    if (opts.tier === 'ci' && !tracked) {
      lines.push(`  SKIP ${mirrorPath}: not present in tracked tree`);
      skipped.push(mirrorPath);
      continue;
    }

    const mirrorMap = treeMap(mirrorAbs);
    if (!mirrorMap) {
      lines.push(`  FAIL ${mirrorPath}: missing skill directory`);
      failures.push(`${group.skill}: missing ${mirrorPath}`);
      continue;
    }

    const diff = compareMaps(canonicalMap, mirrorMap);
    if (diff.ok) {
      lines.push(`  OK ${mirrorPath}`);
      continue;
    }

    lines.push(`  DRIFT ${mirrorPath}`);
    for (const file of diff.missing) lines.push(`    missing: ${file}`);
    for (const file of diff.different) lines.push(`    different: ${file}`);
    for (const file of diff.extra) lines.push(`    extra: ${file}`);

    if (opts.fix) {
      const result = opts.write
        ? writeFix({ root: opts.root, canonicalAbs, mirrorAbs, mirrorPath, diff })
        : applyFix({ root: opts.root, group, canonicalAbs, mirrorAbs, mirrorPath, diff });
      lines.push(...result.lines);
      if (result.conflict) {
        failures.push(`${group.skill}: conflict ${mirrorPath}`);
      } else if (!opts.write) {
        failures.push(`${group.skill}: drift ${mirrorPath}`);
      }
    } else {
      failures.push(`${group.skill}: drift ${mirrorPath}`);
    }
  }

  return { lines, failures, skipped };
}

export function runSkillDriftCheck(rawOpts = {}) {
  const opts = {
    tier: rawOpts.tier || 'local',
    manifest: rawOpts.manifest ? resolve(rawOpts.manifest) : resolve(rawOpts.root || process.cwd(), DEFAULT_MANIFEST),
    root: resolve(rawOpts.root || process.cwd()),
    fix: Boolean(rawOpts.fix),
    write: Boolean(rawOpts.write),
  };
  const manifest = loadManifest(opts.manifest);
  const lines = [`skill-drift-check tier=${opts.tier} root=${opts.root}${opts.fix ? opts.write ? ' fix=write' : ' fix=dry-run' : ''}`];
  const failures = [];
  const skipped = [];

  for (const group of manifest) {
    const result = checkGroup(group, opts);
    lines.push(...result.lines);
    failures.push(...result.failures);
    skipped.push(...result.skipped);
  }

  if (failures.length > 0) {
    lines.push(`\nFAIL ${failures.length} issue(s)`);
    for (const failure of failures) lines.push(`  - ${failure}`);
    return { ok: false, output: `${lines.join('\n')}\n`, failures, skipped };
  }

  lines.push(`\nOK all declared skill mirrors match canonical${skipped.length > 0 ? ` (${skipped.length} skipped in ${opts.tier} tier)` : ''}`);
  return { ok: true, output: `${lines.join('\n')}\n`, failures, skipped };
}

function main() {
  try {
    const opts = parseArgs();
    const result = runSkillDriftCheck(opts);
    process.stdout.write(result.output);
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    process.stderr.write(`skill-drift-check error: ${err.message}\n`);
    process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
