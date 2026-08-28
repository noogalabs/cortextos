#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_ALLOWLIST_ENTRIES = [
  'dist/',
  'schemas/',
  'templates/',
  'scripts/verify-package-files.mjs',
];

export const REQUIRED_BUILD_OUTPUTS = [
  'dist/cli.js',
  'dist/daemon.js',
  'dist/hooks/hook-permission-telegram.js',
  'dist/hooks/hook-ask-telegram.js',
  'dist/hooks/hook-planmode-telegram.js',
  'dist/hooks/hook-crash-alert.js',
  'dist/hooks/hook-compact-telegram.js',
  'dist/hooks/hook-extract-facts.js',
  'dist/hooks/hook-idle-flag.js',
  'dist/hooks/hook-context-status.js',
  'dist/hooks/hook-loop-detector.js',
];

const PACKAGE_SCRIPT_NAMES = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepack',
  'prepare',
  'postpack',
  'prepublish',
  'prepublishOnly',
  'prebuild',
  'build',
  'postbuild',
]);

const normalizePath = (value) => value.replaceAll('\\', '/').replace(/^\.\//, '');

export function isShippedByFiles(relativePath, files = []) {
  const candidate = normalizePath(relativePath);
  return files.some((entry) => {
    const normalized = normalizePath(entry);
    return normalized.endsWith('/') ? candidate.startsWith(normalized) : candidate === normalized;
  });
}

export function localScriptReferences(command = '') {
  return [...command.matchAll(/(?:^|[\s"'])((?:\.\/)?scripts\/[A-Za-z0-9._/-]+\.(?:c?js|mjs|ts))(?=$|[\s"'])/g)]
    .map((match) => normalizePath(match[1]));
}

function packageEntryPoints(pkg) {
  const entries = [];
  if (typeof pkg.main === 'string') entries.push(pkg.main);
  if (typeof pkg.bin === 'string') entries.push(pkg.bin);
  if (pkg.bin && typeof pkg.bin === 'object') {
    for (const value of Object.values(pkg.bin)) {
      if (typeof value === 'string') entries.push(value);
    }
  }
  return entries.map(normalizePath);
}

export function validatePackageManifest(pkg) {
  const errors = [];
  const files = Array.isArray(pkg.files) ? pkg.files.map(normalizePath) : [];

  for (const required of REQUIRED_ALLOWLIST_ENTRIES) {
    if (!files.includes(required)) errors.push(`package.json files must include ${required}`);
  }

  for (const entryPoint of packageEntryPoints(pkg)) {
    if (!isShippedByFiles(entryPoint, files)) {
      errors.push(`package entry point ${entryPoint} is not covered by package.json files`);
    }
  }

  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    if (!PACKAGE_SCRIPT_NAMES.has(name) || typeof command !== 'string') continue;
    for (const scriptPath of localScriptReferences(command)) {
      if (!isShippedByFiles(scriptPath, files)) {
        errors.push(`${name} references ${scriptPath}, but package.json files does not ship it`);
      }
    }
  }

  return errors;
}

export function validatePackedFiles(pkg, packedPaths) {
  const errors = validatePackageManifest(pkg);
  const packed = new Set(packedPaths.map(normalizePath));

  for (const output of new Set([...packageEntryPoints(pkg), ...REQUIRED_BUILD_OUTPUTS])) {
    if (!packed.has(output)) errors.push(`published tarball is missing ${output}`);
  }

  for (const required of REQUIRED_ALLOWLIST_ENTRIES) {
    if (required.endsWith('/')) {
      if (![...packed].some((path) => path.startsWith(required))) {
        errors.push(`published tarball has no files under ${required}`);
      }
    } else if (!packed.has(required)) {
      errors.push(`published tarball is missing ${required}`);
    }
  }

  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    if (!PACKAGE_SCRIPT_NAMES.has(name) || typeof command !== 'string') continue;
    for (const scriptPath of localScriptReferences(command)) {
      if (!packed.has(scriptPath)) {
        errors.push(`${name} references ${scriptPath}, but the published tarball omits it`);
      }
    }
  }

  return [...new Set(errors)];
}

export function npmPackInvocation(runtimePlatform = process.platform) {
  const args = ['pack', '--dry-run', '--json', '--ignore-scripts'];
  // Match the repository's existing Windows npm convention in src/cli/install.ts:
  // npm is a .cmd wrapper there, so let cmd.exe resolve a fixed command string.
  return runtimePlatform === 'win32'
    ? { command: `npm ${args.join(' ')}`, args: undefined, shell: true }
    : { command: 'npm', args, shell: false };
}

export function packedPathsFromNpm(projectRoot) {
  const invocation = npmPackInvocation();
  const result = invocation.args
    ? spawnSync(invocation.command, invocation.args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    : spawnSync(invocation.command, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: invocation.shell,
    });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run failed: ${result.stderr?.trim() || `exit ${result.status}`}`);
  }
  const output = JSON.parse(result.stdout);
  if (!Array.isArray(output) || !Array.isArray(output[0]?.files)) {
    throw new Error('npm pack --dry-run returned an unexpected result');
  }
  return output[0].files.map((file) => file.path);
}

export function verifyPackage(projectRoot) {
  const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));
  const packedPaths = packedPathsFromNpm(projectRoot);
  const errors = validatePackedFiles(pkg, packedPaths);
  if (errors.length > 0) throw new Error(`Package completeness check failed:\n- ${errors.join('\n- ')}`);
  return { packageName: pkg.name, fileCount: packedPaths.length };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const { packageName, fileCount } = verifyPackage(projectRoot);
    console.log(`Package completeness OK: ${packageName} (${fileCount} packed files)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
