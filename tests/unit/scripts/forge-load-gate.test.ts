import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repoRoot = join(__dirname, '../../..');
const scriptPath = join(repoRoot, 'scripts', 'forge-load-gate.mjs');

// The gate refuses to run without a REAL YAML parser (never regex). The repo
// carries `yaml` as a devDependency for exactly this; CTX_FRAMEWORK_ROOT lets
// deployed agents resolve it from the framework checkout.
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

const GOOD_SKILL = `---
name: demo-skill
description: "You MUST use this skill when the demo trigger fires: it proves the gate."
model: haiku
context: fork
triggers: ["demo trigger"]
---

Parse $ARGUMENTS and run the demo.
`;

let tmp: string;
function seed(name: string, content: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf-8');
  return dir;
}

describe('forge-load-gate', () => {
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('passes a fully-featured skill mechanically and still requires the fire-smoke', () => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-gate-'));
    const dir = seed('demo-skill', GOOD_SKILL);
    const res = run([dir]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('PASS (mechanical)');
    expect(res.stdout).toContain('MANUAL fire-smoke');
    expect(res.stdout).toContain('"demo trigger"');
  });

  it('fails on the unquoted colon-space break that regex smoke masked (PR #99)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-gate-'));
    const dir = seed('bad-colon', GOOD_SKILL.replace(
      /description: .*/,
      'description: intake: read the meld and triage it',
    ).replace('name: demo-skill', 'name: bad-colon'));
    const res = run([dir]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('REAL-YAML rejection');
  });

  it('fails an unquoted free-text description even when it happens to parse', () => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-gate-'));
    const dir = seed('unquoted', GOOD_SKILL.replace(
      /description: .*/,
      'description: plain unquoted text that parses today',
    ).replace('name: demo-skill', 'name: unquoted'));
    const res = run([dir]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('not quoted');
  });

  it('fails when name does not match the directory (undiscoverable)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-gate-'));
    const dir = seed('other-dir', GOOD_SKILL);
    const res = run([dir]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('!= directory');
  });

  it('fails when the three ship features are missing (forge hard rule 2)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-gate-'));
    const dir = seed('bare-skill', `---
name: bare-skill
description: "End-of-day review workflow without the required features."
---

A body with no arguments hook.
`);
    const res = run([dir]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('missing `model`');
    expect(res.stdout).toContain('context: fork');
    expect(res.stdout).toContain('triggers');
    expect(res.stdout).toContain('$ARGUMENTS');
    expect(res.stdout).toContain('imperative');
  });

  it('downgrades ship-feature failures to warnings with --lenient (legacy audit only)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-gate-'));
    const dir = seed('bare-skill', `---
name: bare-skill
description: "Legacy skill being audited, not shipped."
---

Legacy body.
`);
    const res = run([dir, '--lenient']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('[lenient]');
  });

  it('fails a referenced skill that does not resolve from the target home tracked tree', () => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-gate-'));
    execFileSync('git', ['init', '-q', tmp]);
    const dir = seed('handoff-skill', GOOD_SKILL.replace('name: demo-skill', 'name: handoff-skill')
      .replace('run the demo.', 'run the demo, then hand off to the `vendor-assign` skill.'));
    const res = run([dir, '--target-home', tmp]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('`vendor-assign` does not resolve from target home');
  });

  it('resolves references via git ls-files when tracked in the target home', () => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-gate-'));
    execFileSync('git', ['init', '-q', tmp]);
    const refDir = join(tmp, 'templates', 'agent', '.claude', 'skills', 'vendor-assign');
    mkdirSync(refDir, { recursive: true });
    writeFileSync(join(refDir, 'SKILL.md'), GOOD_SKILL.replace('name: demo-skill', 'name: vendor-assign'), 'utf-8');
    execFileSync('git', ['-C', tmp, 'add', '.']);
    const dir = seed('handoff-skill', GOOD_SKILL.replace('name: demo-skill', 'name: handoff-skill')
      .replace('run the demo.', 'run the demo, then hand off to the `vendor-assign` skill.'));
    // seed() wrote the skill after `git add`, so handoff-skill itself is untracked —
    // only the REFERENCE resolution is under test here.
    const res = run([dir, '--target-home', tmp]);
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain('vendor-assign` does not resolve');
  });
});
