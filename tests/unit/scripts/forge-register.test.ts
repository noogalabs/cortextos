import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repoRoot = join(__dirname, '../../..');
const scriptPath = join(repoRoot, 'scripts', 'forge-register.mjs');
// CTX_FRAMEWORK_ROOT lets the load gate resolve a real YAML parser from the repo.
const env = { ...process.env, CTX_FRAMEWORK_ROOT: repoRoot };

function run(args: string[]) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

// A skill that passes the combined load gate (name==dir, quoted+imperative
// description, model + context:fork, non-empty triggers, $ARGUMENTS in body,
// no external skill references).
const VALID_SKILL = `---
name: stage-test-skill
description: "You MUST use this skill when exercising the stage stale-file regression."
model: haiku
context: fork
triggers: ["stage test trigger"]
---

Body references $ARGUMENTS and names no other skills.
`;

let tmp: string;
let home: string;

function makeSource(dir: string, files: Record<string, string>): string {
  const skillDir = join(dir, 'stage-test-skill');
  mkdirSync(skillDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(skillDir, name), content, 'utf-8');
  }
  return skillDir;
}

describe('forge-register stage', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-register-'));
    // Home must be inside a git repo and NOT look like a live agent runtime dir.
    execFileSync('git', ['init', '-q', tmp]);
    home = join(tmp, 'community', 'skills');
    mkdirSync(home, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('clears stale files on re-stage (rm-before-copy, not a merge)', () => {
    // First stage: source has SKILL.md + an extra file.
    const srcA = makeSource(join(tmp, 'srcA'), {
      'SKILL.md': VALID_SKILL,
      'helper.txt': 'first version helper',
    });
    const first = run(['stage', '--from', srcA, '--home', home]);
    expect(first.status).toBe(0);
    const dest = join(home, 'stage-test-skill');
    expect(existsSync(join(dest, 'helper.txt'))).toBe(true);

    // Re-stage from a source that DROPPED helper.txt. A bare cpSync would merge
    // and leave the stale helper.txt behind; rm-before-copy must remove it.
    const srcB = makeSource(join(tmp, 'srcB'), { 'SKILL.md': VALID_SKILL });
    const second = run(['stage', '--from', srcB, '--home', home]);
    expect(second.status).toBe(0);
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dest, 'helper.txt'))).toBe(false); // stale file gone
  });
});
