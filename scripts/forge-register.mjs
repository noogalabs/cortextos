#!/usr/bin/env node
/**
 * forge-register.mjs — two-step registration enforcement (forge hard rule 6).
 *
 * Live agent skill dirs (`<agent>/.claude/skills/`) are gitignored runtime —
 * NOT a PR target, and never the FIRST write. Registration is always two steps:
 *
 *   stage     Step 1: copy a built skill into its TRACKED home (role template
 *             or community/skills/) and run the combined load gate against
 *             that home. Output is a ready-to-PR working-tree change — this
 *             script never commits, merges, or pushes (forge hard rule 7:
 *             specs + change-sets, not auto-merges).
 *
 *   activate  Step 2 (AFTER the PR merged and the orchestrator gate approved):
 *             copy the skill from the TRACKED source into the live runtime
 *             dir, byte-identical, then print the in-context trigger-fire
 *             smoke. Refuses to run unless:
 *               --gate-approved-by <name> is passed (who held the gate), and
 *               the source path is tracked in git (so a single write to a
 *               gitignored live dir is structurally impossible here).
 *
 * Usage:
 *   node scripts/forge-register.mjs stage   --from <built-skill-dir> --home <tracked-skills-dir>
 *   node scripts/forge-register.mjs activate --from <tracked-skill-dir> --runtime <live-skills-dir> \
 *        --gate-approved-by <name>
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLoadGate } from './forge-load-gate.mjs';

function gitTracked(path) {
  try {
    const out = execFileSync('git', ['-C', resolve(path, '..'), 'ls-files', '--', basename(path)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function hashTree(dir) {
  const hash = createHash('sha256');
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        hash.update(entry.name);
        hash.update(readFileSync(abs));
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      opts[key] = rest[++i];
    }
  }
  return { cmd, opts };
}

function stage(opts) {
  if (!opts.from || !opts.home) {
    console.error('stage: --from <built-skill-dir> and --home <tracked-skills-dir> are required');
    process.exit(2);
  }
  const from = resolve(opts.from);
  const home = resolve(opts.home);
  const name = basename(from);
  const dest = join(home, name);
  if (!existsSync(join(from, 'SKILL.md'))) {
    console.error(`stage: ${from} has no SKILL.md`);
    process.exit(1);
  }
  if (!existsSync(home)) {
    console.error(`stage: tracked home ${home} does not exist — register into a role template or community/skills/, never a live agent dir`);
    process.exit(1);
  }
  // The HOME itself must be tracked territory; the new skill dir inside it is new.
  const homeRepoCheck = (() => {
    try {
      execFileSync('git', ['-C', home, 'rev-parse', '--git-dir'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  if (!homeRepoCheck) {
    console.error(`stage: ${home} is not inside a git repo — not a tracked home`);
    process.exit(1);
  }
  if (/\/agents\/[^/]+\/\.claude\/skills/.test(home)) {
    console.error(`stage: ${home} looks like a LIVE agent runtime dir — that is step 2 (activate), never the PR target (forge hard rule 6)`);
    process.exit(1);
  }
  // Clear any prior staged copy first: a bare cpSync into an existing dest
  // MERGES, so a built source that renamed/deleted a file leaves the stale file
  // behind and it becomes part of the PR (same class as the activate fix, other
  // call site). rm-then-copy makes the staged dest exactly mirror the source.
  rmSync(dest, { recursive: true, force: true });
  cpSync(from, dest, { recursive: true });
  console.log(`staged ${name} -> ${dest}`);
  // Pass the skills home itself: the gate now resolves references as the exact
  // path relative to the home (`git ls-files --error-unmatch -- <ref>/SKILL.md`
  // from <home>), so the home — not the repo root — is the correct scope. (The
  // old repo-root workaround for the unanchored `*skills/` glob over-broadened
  // to a false-green; the anchored gate makes `home` correct.)
  const gate = runLoadGate([dest], { targetHome: home });
  process.stdout.write(gate.output);
  if (!gate.ok) {
    console.error('stage: load gate FAILED — fix before opening the PR');
    process.exit(1);
  }
  console.log('next: open the PR from this working-tree change (Codex + review -> orchestrator gate). Do NOT activate until merged + gated.');
}

function activate(opts) {
  if (!opts.from || !opts.runtime) {
    console.error('activate: --from <tracked-skill-dir> and --runtime <live-skills-dir> are required');
    process.exit(2);
  }
  if (!opts.gateApprovedBy) {
    console.error('activate: REFUSED — pass --gate-approved-by <name>. Runtime activation only happens after the tracked-source PR merged and the orchestrator gate approved (forge hard rule 6).');
    process.exit(1);
  }
  const from = resolve(opts.from);
  const name = basename(from);
  if (!statSync(from, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`activate: ${from} is not a directory`);
    process.exit(1);
  }
  if (!gitTracked(from)) {
    console.error(`activate: REFUSED — ${from} is not git-tracked. Activation copies FROM the tracked source only; a single write to a gitignored live dir is exactly what rule 6 forbids.`);
    process.exit(1);
  }
  const dest = join(resolve(opts.runtime), name);
  // Copy into a sibling temp dir and verify byte-identity BEFORE touching the
  // live runtime path. A direct cpSync into an existing dest MERGES — files
  // removed from the tracked source linger, and the hash check would only fail
  // AFTER the live skill was already partially overwritten. Temp-then-swap keeps
  // the live dir untouched until the copy is proven clean, and the swap removes
  // any stale files (rename replaces the whole dir).
  const tmpDest = `${dest}.forge-activate-tmp`;
  rmSync(tmpDest, { recursive: true, force: true });
  cpSync(from, tmpDest, { recursive: true });
  const srcHash = hashTree(from);
  const tmpHash = hashTree(tmpDest);
  if (srcHash !== tmpHash) {
    rmSync(tmpDest, { recursive: true, force: true });
    console.error(`activate: byte-identity check FAILED (${srcHash} != ${tmpHash}) — live runtime untouched`);
    process.exit(1);
  }
  // Check passed — now swap atomically: drop the old dir, rename temp into place.
  rmSync(dest, { recursive: true, force: true });
  renameSync(tmpDest, dest);
  console.log(`activated ${name} -> ${dest} (byte-identical to tracked source, sha256 ${srcHash.slice(0, 12)}…, gate: ${opts.gateApprovedBy})`);
  // Print the fire-smoke — activation is not done until this ran in-context.
  const gate = runLoadGate([dest], { lenient: true });
  process.stdout.write(gate.output);
  console.log('next: run the MANUAL fire-smoke above IN THE TARGET AGENT\'S SESSION, then send the agent a heads-up. Activation without a fired trigger is not done.');
}

function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (cmd === 'stage') stage(opts);
  else if (cmd === 'activate') activate(opts);
  else {
    console.error('Usage: forge-register.mjs <stage|activate> — see file header');
    process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
