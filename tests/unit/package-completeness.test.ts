import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  REQUIRED_BUILD_OUTPUTS,
  packedPathsFromNpm,
  validatePackedFiles,
  validatePackageManifest,
} from '../../scripts/verify-package-files.mjs';

const repositoryRoot = process.cwd();
const packageMetadata = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
const scratchDirectories: string[] = [];

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratchDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratchDirectories.push(directory);
  return directory;
}

function buildScratchPackage(): string {
  const packageRoot = scratchDirectory('cortextos-package-');
  const outputDirectory = join(packageRoot, 'dist');
  mkdirSync(outputDirectory, { recursive: true });

  execFileSync('npx', ['tsup', '--silent', '--out-dir', outputDirectory], {
    cwd: repositoryRoot,
    stdio: 'pipe',
  });

  for (const path of ['package.json', 'README.md', 'LICENSE', 'schemas', 'templates']) {
    cpSync(join(repositoryRoot, path), join(packageRoot, path), { recursive: true });
  }
  mkdirSync(join(packageRoot, 'scripts'), { recursive: true });
  cpSync(
    join(repositoryRoot, 'scripts', 'verify-package-files.mjs'),
    join(packageRoot, 'scripts', 'verify-package-files.mjs'),
  );
  return packageRoot;
}

describe('published-package completeness', () => {
  it('emits every intended CLI, daemon, and hook bundle', { timeout: 60_000 }, () => {
    const packageRoot = buildScratchPackage();
    const packedPaths = packedPathsFromNpm(packageRoot);

    expect(validatePackedFiles(packageMetadata, packedPaths)).toEqual([]);
    for (const output of REQUIRED_BUILD_OUTPUTS) expect(packedPaths).toContain(output);
  });

  it('rejects a missing command binary or hook output', () => {
    const complete = [
      'scripts/verify-package-files.mjs',
      'schemas/status.json',
      'templates/agent/config.json',
      ...REQUIRED_BUILD_OUTPUTS,
    ];

    expect(validatePackedFiles(packageMetadata, complete.filter((path) => path !== 'dist/cli.js')))
      .toContain('published tarball is missing dist/cli.js');
    expect(validatePackedFiles(packageMetadata, complete.filter((path) => path !== 'dist/hooks/hook-crash-alert.js')))
      .toContain('published tarball is missing dist/hooks/hook-crash-alert.js');
  });

  it('rejects a package hook that references an unshipped local script', () => {
    const mutated = structuredClone(packageMetadata);
    mutated.scripts.postinstall = 'node ./scripts/repair-install.mjs';

    expect(validatePackageManifest(mutated)).toContain(
      'postinstall references scripts/repair-install.mjs, but package.json files does not ship it',
    );
  });

  it('fails against a real tarball when an intended hook bundle disappears', { timeout: 60_000 }, () => {
    const packageRoot = buildScratchPackage();
    rmSync(join(packageRoot, 'dist', 'hooks', 'hook-idle-flag.js'));
    rmSync(join(packageRoot, 'dist', 'hooks', 'hook-idle-flag.js.map'));

    expect(validatePackedFiles(packageMetadata, packedPathsFromNpm(packageRoot))).toContain(
      'published tarball is missing dist/hooks/hook-idle-flag.js',
    );
  });
});
