#!/usr/bin/env node
/**
 * forge-load-gate.mjs — combined LOAD GATE for forged skills (forge hard rules 2/4/5).
 *
 * ONE combined check, all parts required before a skill ships:
 *
 *   1. PARSE        Frontmatter parses with a REAL YAML parser — never regex.
 *                   Regex frontmatter smoke MASKED the unquoted-colon break
 *                   (PR #99, 2026-06-06): `description: intake: read` is
 *                   rejected by the harness loader and the skill silently
 *                   never loads. If no real YAML parser is resolvable this
 *                   gate FAILS LOUD (exit 2) — it never falls back to regex.
 *
 *   2. DISCOVERABLE Loader-visible: name present + matches the directory name,
 *                   non-empty description, free-text frontmatter values QUOTED
 *                   (so future punctuation cannot reintroduce the parse break).
 *
 *   3. SHIP FEATURES (forge hard rule 2) model tier + `context: fork` +
 *                   `$ARGUMENTS` in the body + imperative description (MUST) +
 *                   a separate non-empty `triggers` array. Missing any = not done.
 *                   `--lenient` downgrades these to warnings (auditing legacy
 *                   skills only — never for shipping a forged skill).
 *
 *   4. REFERENCES   Every referenced skill resolves FROM THE TARGET HOME via
 *                   `git ls-files` (tracked tree — NOT an unscoped find, which
 *                   sweeps gitignored runtime dirs and gives a false green;
 *                   PR #99 vendor-assign dangle, PR #104 skill-optimizer/
 *                   auto-skill). With --runtime-dir, also checks the live
 *                   runtime the skill activates into.
 *
 *   5. FIRES        Cannot be proven by a script outside the target agent's
 *                   context. The gate prints the exact in-context trigger-fire
 *                   smoke to run and reports it as MANUAL-REQUIRED. A gate
 *                   pass here is "mechanically green, fire-smoke pending" —
 *                   never claim the skill fired without running that smoke.
 *
 * Usage:
 *   node scripts/forge-load-gate.mjs <skill-dir>... [--target-home <skills-home>]
 *        [--runtime-dir <live-skills-dir>] [--refs name1,name2] [--lenient] [--json]
 *   <skills-home> is the dir directly containing skill subdirs (a role-template
 *   `.claude/skills` dir or `community/skills`) — NOT the repo root; references
 *   resolve as <skills-home>/<ref>/SKILL.md.
 *
 * Exit codes: 0 = mechanical gates pass (fire-smoke still required),
 *             1 = gate failure, 2 = no real YAML parser / bad invocation.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);

/**
 * Resolve a REAL YAML parser. Search order: this repo's node_modules, the
 * dashboard workspace (Next.js brings js-yaml transitively), CTX_FRAMEWORK_ROOT,
 * cwd. Returns { parse, source } or null. NO regex fallback, ever.
 */
export function resolveYamlParser(extraRoots = []) {
  const scriptRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
  const roots = [
    ...extraRoots,
    scriptRoot,
    join(scriptRoot, 'dashboard'),
    process.env.CTX_FRAMEWORK_ROOT || '',
    process.env.CTX_FRAMEWORK_ROOT ? join(process.env.CTX_FRAMEWORK_ROOT, 'dashboard') : '',
    process.cwd(),
    join(process.cwd(), 'dashboard'),
  ].filter(Boolean);

  for (const root of roots) {
    for (const pkg of ['yaml', 'js-yaml']) {
      try {
        const resolved = require_.resolve(pkg, { paths: [root] });
        const mod = require_(resolved);
        if (pkg === 'yaml' && typeof mod.parse === 'function') {
          return { parse: (text) => mod.parse(text), source: resolved };
        }
        if (pkg === 'js-yaml' && typeof mod.load === 'function') {
          return { parse: (text) => mod.load(text), source: resolved };
        }
      } catch {
        // keep searching
      }
    }
  }
  return null;
}

/** Structural frontmatter extraction (delimiter split only — parsing is YAML's job). */
export function extractFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return { error: 'file does not start with a `---` frontmatter block' };
  }
  const end = text.indexOf('\n---', 3);
  if (end === -1) {
    return { error: 'frontmatter block is not closed with `---`' };
  }
  return {
    raw: text.slice(text.indexOf('\n') + 1, end + 1),
    body: text.slice(text.indexOf('\n', end + 1) + 1),
  };
}

function rawValueIsQuoted(raw, key) {
  const m = raw.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!m) return true; // absence is reported by other checks
  const v = m[1].trim();
  if (v === '' || v.startsWith('[') || v.startsWith('>') || v.startsWith('|')) return true;
  return v.startsWith('"') || v.startsWith("'");
}

/** Find skill names this skill references in its body. */
export function findReferencedSkills(body) {
  const names = new Set();
  for (const m of body.matchAll(/`([a-z][a-z0-9-]{2,})`\s+(?:skill|method)/g)) names.add(m[1]);
  for (const m of body.matchAll(/skills\/([a-z][a-z0-9-]{2,})\//g)) names.add(m[1]);
  return [...names];
}

function trackedSkillResolves(targetHome, name) {
  try {
    // Resolve the EXACT path relative to the target home: the referenced skill
    // must be tracked at <targetHome>/<name>/SKILL.md. The prior unanchored
    // `*skills/<name>` glob matched a skill ANYWHERE in the repo from a repo-root
    // home (false-GREEN — a ref absent from the actual home still "resolved")
    // and matched NOTHING from a skills-subdir cwd (false-RED — relative paths
    // lack the `skills/` prefix). `--error-unmatch` on the home-relative path is
    // anchored correctly at both ends: exit 0 iff that exact path is tracked.
    execFileSync('git', ['-C', targetHome, 'ls-files', '--error-unmatch', '--', join(name, 'SKILL.md')], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function gateSkill(skillDir, opts = {}) {
  const dir = resolve(skillDir);
  const results = { skill: dir, failures: [], warnings: [], manual: [] };
  const fail = (msg) => results.failures.push(msg);
  const warn = (msg) => results.warnings.push(msg);
  const feature = (msg) => (opts.lenient ? warn(`[lenient] ${msg}`) : fail(msg));

  const skillFile = statSync(dir, { throwIfNoEntry: false })?.isDirectory()
    ? join(dir, 'SKILL.md')
    : dir;
  if (!existsSync(skillFile)) {
    fail(`SKILL.md not found at ${skillFile}`);
    return results;
  }
  const dirName = basename(skillFile) === 'SKILL.md' ? basename(resolve(skillFile, '..')) : null;
  const text = readFileSync(skillFile, 'utf-8');

  // Gate 1 — PARSE (real YAML)
  const fm = extractFrontmatter(text);
  if (fm.error) {
    fail(`parse: ${fm.error}`);
    return results;
  }
  let data;
  try {
    data = opts.yaml.parse(fm.raw);
  } catch (err) {
    fail(`parse: REAL-YAML rejection — the harness loader will silently skip this skill: ${String(err.message).split('\n')[0]}`);
    return results;
  }
  if (!data || typeof data !== 'object') {
    fail('parse: frontmatter is not a YAML mapping');
    return results;
  }

  // Gate 2 — DISCOVERABLE
  if (!data.name) fail('discoverable: missing `name`');
  else if (dirName && data.name !== dirName) fail(`discoverable: name \`${data.name}\` != directory \`${dirName}\``);
  if (!data.description || String(data.description).trim() === '') fail('discoverable: missing/empty `description`');
  for (const key of ['description']) {
    if (data[key] && !rawValueIsQuoted(fm.raw, key)) {
      fail(`discoverable: \`${key}\` value is not quoted — quote every free-text frontmatter value so punctuation cannot break the YAML load (forge hard rule 4)`);
    }
  }

  // Gate 3 — SHIP FEATURES (forge hard rule 2)
  if (!data.model) feature('features: missing `model` tier (fork works both directions — heavy forks UP, rote forks DOWN)');
  if (data.context !== 'fork') feature('features: missing `context: fork`');
  if (!Array.isArray(data.triggers) || data.triggers.length === 0) feature('features: missing/empty `triggers` array');
  if (!fm.body.includes('$ARGUMENTS') && !String(data.description || '').includes('$ARGUMENTS')) {
    feature('features: `$ARGUMENTS` is never referenced — scope cannot be passed in');
  }
  if (!/\bMUST\b/.test(String(data.description || ''))) {
    feature('features: description is not imperative — say when the agent MUST use it');
  }

  // Gate 4 — REFERENCES resolve from the target home (tracked tree)
  const targetHome = opts.targetHome ? resolve(opts.targetHome) : null;
  const refs = new Set([
    ...findReferencedSkills(fm.body),
    ...(opts.refs || []),
  ]);
  refs.delete(data.name);
  for (const ref of refs) {
    if (targetHome) {
      if (!trackedSkillResolves(targetHome, ref)) {
        fail(`references: \`${ref}\` does not resolve from target home ${targetHome} (git ls-files — tracked tree only). Dead activation risk (PR #99 / #104). Name the method instead of hard-invoking, or register \`${ref}\` first.`);
      }
    } else {
      warn(`references: \`${ref}\` found but no --target-home given — cannot verify it resolves where the skill will run`);
    }
    if (opts.runtimeDir && !existsSync(join(opts.runtimeDir, ref, 'SKILL.md'))) {
      warn(`references: \`${ref}\` absent from runtime ${opts.runtimeDir} — it will not be loadable in the running agent; forge must not hard-depend on it`);
    }
  }

  // Gate 5 — FIRES on its trigger (manual, in target agent context)
  const trigger = Array.isArray(data.triggers) && data.triggers.length > 0 ? data.triggers[0] : '<trigger phrase>';
  results.manual.push(
    `fire-smoke (REQUIRED before ship-complete): in the TARGET agent's session, say "${trigger}" and confirm the \`${data.name || dirName}\` skill loads and runs. A skill that shipped but never fired is itself a forge candidate.`,
  );

  return results;
}

export function runLoadGate(skillDirs, opts = {}) {
  const yaml = opts.yaml || resolveYamlParser(opts.parserRoots || []);
  if (!yaml) {
    return {
      ok: false,
      noParser: true,
      output:
        'forge-load-gate: NO REAL YAML PARSER resolvable (looked for `yaml`/`js-yaml` in repo, dashboard/, CTX_FRAMEWORK_ROOT, cwd).\n' +
        'Refusing to gate — a regex fallback is exactly the masked-failure this gate exists to prevent (PR #99). Install `yaml` or run from a root that has it.\n',
      results: [],
    };
  }
  const results = skillDirs.map((d) => gateSkill(d, { ...opts, yaml }));
  const lines = [`forge-load-gate (yaml: ${yaml.source})`];
  let ok = true;
  for (const r of results) {
    const status = r.failures.length === 0 ? 'PASS (mechanical) — fire-smoke pending' : 'FAIL';
    if (r.failures.length > 0) ok = false;
    lines.push(`\n${r.skill}\n  ${status}`);
    for (const f of r.failures) lines.push(`  FAIL ${f}`);
    for (const w of r.warnings) lines.push(`  WARN ${w}`);
    for (const m of r.manual) lines.push(`  MANUAL ${m}`);
  }
  lines.push(ok ? '\nOK mechanical gates green — run the fire-smoke before calling it shipped' : '\nFAIL load gate');
  return { ok, output: `${lines.join('\n')}\n`, results };
}

function parseArgs(argv) {
  const opts = { skills: [], refs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--target-home') opts.targetHome = argv[++i];
    else if (arg === '--runtime-dir') opts.runtimeDir = argv[++i];
    else if (arg === '--refs') opts.refs = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--lenient') opts.lenient = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('see header of scripts/forge-load-gate.mjs');
      process.exit(0);
    } else opts.skills.push(arg);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.skills.length === 0) {
    console.error('forge-load-gate: pass at least one skill dir (or SKILL.md path)');
    process.exit(2);
  }
  const result = runLoadGate(opts.skills, opts);
  if (opts.json) {
    console.log(JSON.stringify(result.results, null, 2));
  } else {
    process.stdout.write(result.output);
  }
  if (result.noParser) process.exit(2);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
